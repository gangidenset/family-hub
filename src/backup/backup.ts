// バックアップ・復元 (docs/04-data-model.md §7, docs/07-security.md S-4)
import { z } from 'zod';
import { idSchema, recordSchemas, SHARED_TABLES, validateOp, type AnyRecord, type Op, type SharedTable } from '../domain/schemas';
import { SCHEMA_VERSION, type DeviceMeta, type FamilyDB } from '../db/db';
import { deleteGroupData } from '../db/group';
import { addGroupKey, create, ensureDevice, getSession, setSession } from '../db/repo';
import { fromB64url, randomBytes, safeJsonParse, toB64url } from '../lib/bytes';
import { open, passphraseKey, PBKDF2_ITERATIONS, seal, sha256Hex } from '../sync/crypto';

export const BACKUP_FORMAT = 'familyhub-backup';
export const ENCRYPTED_FORMAT = 'familyhub-backup-encrypted';
export const BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const APP_VERSION = '1.0.0';

export type BackupErrorCode =
  | 'too-large'
  | 'not-json'
  | 'not-backup'
  | 'newer-version'
  | 'checksum'
  | 'invalid-record'
  | 'needs-passphrase'
  | 'wrong-passphrase';

export class BackupError extends Error {
  constructor(public code: BackupErrorCode, public detail?: string) {
    super(code);
    this.name = 'BackupError';
  }
}

const keySchema = z.strictObject({ epoch: z.number().int().min(1).max(1_000_000), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

const dataSchema = z.strictObject(
  Object.fromEntries(SHARED_TABLES.map((t) => [t, z.array(z.unknown()).max(200_000)])) as Record<SharedTable, z.ZodArray<z.ZodUnknown>>,
);

const backupSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().max(20),
  schemaVersion: z.number().int().min(1),
  exportedAt: z.iso.datetime(),
  group: z.strictObject({ id: idSchema, name: z.string().max(100) }),
  memberId: idSchema,
  data: dataSchema,
  oplog: z.array(z.unknown()).max(2_000_000),
  keys: z.array(keySchema).max(1000).optional(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

const encryptedSchema = z.strictObject({
  format: z.literal(ENCRYPTED_FORMAT),
  formatVersion: z.number().int().min(1),
  kdf: z.strictObject({
    name: z.literal('PBKDF2-SHA256'),
    iterations: z.number().int().min(100_000).max(5_000_000),
    salt: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  }),
  iv: z.string().max(32),
  ct: z.string(),
});

export interface ParsedBackup {
  groupId: string;
  groupName: string;
  memberId: string;
  exportedAt: string;
  appVersion: string;
  records: { [K in SharedTable]: AnyRecord[] };
  oplog: Op[];
  keys: { epoch: number; key: string }[] | null;
  counts: Record<SharedTable, number>;
  warnings: string[];
}

function checksumInput(data: unknown, oplog: unknown): string {
  return JSON.stringify([data, oplog]);
}

/** 現在のグループをバックアップ用オブジェクトにする */
export async function buildBackup(db: FamilyDB, groupId: string, memberId: string, opts: { includeKeys: boolean }) {
  const data = {} as Record<SharedTable, AnyRecord[]>;
  for (const t of SHARED_TABLES) {
    data[t] = t === 'groups' ? ((await db.groups.where('id').equals(groupId).toArray()) as AnyRecord[]) : ((await db.shared(t).where('groupId').equals(groupId).toArray()) as AnyRecord[]);
  }
  const oplog = await db.oplog.where('[groupId+deviceId+seq]').between([groupId, '', 0], [groupId, '￿', Infinity]).toArray();
  const group = await db.groups.get(groupId);
  const backup: z.infer<typeof backupSchema> = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    group: { id: groupId, name: group?.name ?? '' },
    memberId,
    data,
    oplog,
    checksum: `sha256:${await sha256Hex(checksumInput(data, oplog))}`,
  };
  if (opts.includeKeys) {
    const keys = await db.groupKeys.where('[groupId+epoch]').between([groupId, 0], [groupId, Infinity]).toArray();
    backup.keys = keys.map((k) => ({ epoch: k.epoch, key: k.key }));
  }
  return backup;
}

/** 書き出し用の文字列 (passphrase 指定時は鍵込み・暗号化) */
export async function exportBackup(db: FamilyDB, groupId: string, memberId: string, passphrase?: string): Promise<string> {
  if (!passphrase) return JSON.stringify(await buildBackup(db, groupId, memberId, { includeKeys: false }));
  const plain = JSON.stringify(await buildBackup(db, groupId, memberId, { includeKeys: true }));
  const salt = randomBytes(16);
  const key = await passphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
  const sealed = await seal(key, plain, ENCRYPTED_FORMAT);
  return JSON.stringify({
    format: ENCRYPTED_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64url(salt) },
    ...sealed,
  });
}

/** ファイル内容を検証してプレビュー情報を返す。DB には書き込まない */
export async function parseBackup(text: string, passphrase?: string): Promise<ParsedBackup> {
  if (text.length > MAX_BACKUP_BYTES) throw new BackupError('too-large');
  let json: unknown;
  try {
    json = safeJsonParse(text);
  } catch {
    throw new BackupError('not-json');
  }
  const fmt = (json as { format?: unknown; formatVersion?: unknown } | null) ?? {};
  if (fmt.format === ENCRYPTED_FORMAT) {
    if (typeof fmt.formatVersion === 'number' && fmt.formatVersion > BACKUP_FORMAT_VERSION) throw new BackupError('newer-version');
    const enc = encryptedSchema.safeParse(json);
    if (!enc.success) throw new BackupError('not-backup');
    if (!passphrase) throw new BackupError('needs-passphrase');
    let plain: string;
    try {
      const key = await passphraseKey(passphrase, fromB64url(enc.data.kdf.salt), enc.data.kdf.iterations);
      plain = await open(key, enc.data, ENCRYPTED_FORMAT);
    } catch {
      throw new BackupError('wrong-passphrase');
    }
    return parseBackup(plain);
  }
  if (fmt.format !== BACKUP_FORMAT) throw new BackupError('not-backup');
  if (typeof fmt.formatVersion === 'number' && fmt.formatVersion > BACKUP_FORMAT_VERSION) throw new BackupError('newer-version');
  const parsed = backupSchema.safeParse(json);
  if (!parsed.success) throw new BackupError('not-backup', parsed.error.issues[0]?.path.join('.'));
  const b = parsed.data;
  if (`sha256:${await sha256Hex(checksumInput(b.data, b.oplog))}` !== b.checksum) throw new BackupError('checksum');

  const records = {} as ParsedBackup['records'];
  const counts = {} as Record<SharedTable, number>;
  for (const t of SHARED_TABLES) {
    records[t] = b.data[t].map((r, i) => {
      const res = recordSchemas[t].safeParse(r);
      if (!res.success) throw new BackupError('invalid-record', `${t}[${i}].${res.error.issues[0]?.path.join('.')}`);
      if (res.data.groupId !== b.group.id) throw new BackupError('invalid-record', `${t}[${i}].groupId`);
      return res.data as AnyRecord;
    });
    counts[t] = records[t].filter((r) => !r.deleted).length;
  }
  const oplog = b.oplog.map((o, i) => {
    try {
      const op = validateOp(o);
      if (op.groupId !== b.group.id) throw new Error();
      return op;
    } catch {
      throw new BackupError('invalid-record', `oplog[${i}]`);
    }
  });
  if (!records.groups.some((g) => g.id === b.group.id)) throw new BackupError('invalid-record', 'groups');

  // 参照整合性 (致命的ではないので警告のみ)
  const warnings: string[] = [];
  const listIds = new Set(records.shoppingLists.map((l) => l.id));
  const orphan = (records.shoppingItems as { listId: string }[]).filter((i) => !listIds.has(i.listId)).length;
  if (orphan) warnings.push(`リストが見つからない買い物項目が ${orphan} 件あります`);

  return {
    groupId: b.group.id,
    groupName: b.group.name,
    memberId: b.memberId,
    exportedAt: b.exportedAt,
    appVersion: b.appVersion,
    records,
    oplog,
    keys: b.keys ?? null,
    counts,
    warnings,
  };
}

/**
 * 復元: 端末内の現在のグループと、バックアップと同じグループのデータを置き換える (単一トランザクション)。
 */
export async function restoreBackup(db: FamilyDB, backup: ParsedBackup, currentGroupId: string | null): Promise<void> {
  let oldDeviceId = '';
  await ensureDevice(db);
  if (currentGroupId && currentGroupId !== backup.groupId) await deleteGroupData(db, currentGroupId);
  await deleteGroupData(db, backup.groupId);
  const tables = [...SHARED_TABLES.map((t) => db.shared(t)), db.oplog, db.meta, db.groupKeys];
  await db.transaction('rw', tables, async () => {
    for (const t of SHARED_TABLES) await db.shared(t).bulkPut(backup.records[t] as never[]);
    await db.oplog.bulkPut(backup.oplog);
    // 復元後は新しい端末 ID を使う。古いバックアップを戻しても自端末の操作連番に欠番が生じず、
    // バックアップ以降の自分の変更は家族の端末から「他端末の操作」として取り戻せる。
    const device = (await db.meta.get('device')) as DeviceMeta;
    await db.meta.put({ ...device, deviceId: crypto.randomUUID(), seq: 0 });
    oldDeviceId = device.deviceId;
  });
  if (backup.keys) for (const k of backup.keys) await addGroupKey(db, backup.groupId, k.epoch, k.key);
  const members = backup.records.members.filter((m) => !m.deleted);
  const memberId = members.some((m) => m.id === backup.memberId) ? backup.memberId : (members[0]?.id ?? backup.memberId);
  await setSession(db, backup.groupId, memberId);
  const session = await getSession(db);
  if (session) {
    const oldName = (backup.records.devices as { id: string; name: string }[]).find((d) => d.id === oldDeviceId)?.name;
    await create(db, session, 'devices', { name: oldName ?? '復元した端末', memberId, revoked: false }, session.deviceId);
  }
}

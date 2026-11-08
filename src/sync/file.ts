// 代替手段: 暗号化同期ファイル (docs/06-sync-design.md §4.5)
import { z } from 'zod';
import { idSchema, type Op } from '../domain/schemas';
import type { FamilyDB } from '../db/db';
import { getVector, latestKey, opsSince, type Session } from '../db/repo';
import { safeJsonParse } from '../lib/bytes';
import { deriveGroupKeys, open, seal } from './crypto';
import { applyOps, type ApplyResult } from './merge';
import { savePeer, SyncError } from './protocol';

export const SYNC_FILE_FORMAT = 'familyhub-sync';
export const MAX_SYNC_FILE_BYTES = 50 * 1024 * 1024;

const fileSchema = z.strictObject({
  format: z.literal(SYNC_FILE_FORMAT),
  v: z.literal(1),
  groupId: idSchema,
  epoch: z.number().int().min(1),
  from: idSchema,
  createdAt: z.iso.datetime(),
  iv: z.string().max(32),
  ct: z.string(),
});
const payloadSchema = z.strictObject({ ops: z.array(z.unknown()), vector: z.record(idSchema, z.number().int().min(0)) });

const aad = (groupId: string, epoch: number, from: string) => `${SYNC_FILE_FORMAT}|${groupId}|${epoch}|${from}`;

/** 全操作ログを暗号化したファイル内容を作る (受け手は冪等に取り込むので全件で安全) */
export async function exportSyncFile(db: FamilyDB, session: Session): Promise<{ text: string; count: number }> {
  const key = await latestKey(db, session.groupId);
  if (!key) throw new SyncError('missing-key');
  const ops: Op[] = await opsSince(db, session.groupId, {});
  const payload = JSON.stringify({ ops, vector: await getVector(db, session.groupId) });
  const keys = await deriveGroupKeys(key.key);
  const sealed = await seal(keys.file, payload, aad(session.groupId, key.epoch, session.deviceId));
  const text = JSON.stringify({
    format: SYNC_FILE_FORMAT,
    v: 1,
    groupId: session.groupId,
    epoch: key.epoch,
    from: session.deviceId,
    createdAt: new Date().toISOString(),
    ...sealed,
  });
  return { text, count: ops.length };
}

export async function importSyncFile(db: FamilyDB, session: Session, text: string): Promise<ApplyResult> {
  if (text.length > MAX_SYNC_FILE_BYTES) throw new SyncError('invalid-data');
  let file: z.infer<typeof fileSchema>;
  try {
    file = fileSchema.parse(safeJsonParse(text));
  } catch {
    throw new SyncError('invalid-data');
  }
  if (file.groupId !== session.groupId) throw new SyncError('different-group');
  const peerDevice = await db.devices.get(file.from);
  if (peerDevice?.revoked) throw new SyncError('revoked');
  const gk = await db.groupKeys.get([session.groupId, file.epoch]);
  if (!gk) throw new SyncError('missing-key');
  let payload: z.infer<typeof payloadSchema>;
  try {
    const keys = await deriveGroupKeys(gk.key);
    payload = payloadSchema.parse(safeJsonParse(await open(keys.file, file, aad(file.groupId, file.epoch, file.from))));
  } catch {
    throw new SyncError('auth-failed');
  }
  const result = await applyOps(db, session.groupId, payload.ops);
  const prev = await db.peers.get([session.groupId, file.from]);
  // ファイルの送り手が持っている状態 = ファイル内のベクタ (送り手は自分の変更を受け取っていない可能性があるので vector は送り手のものを記録)
  await savePeer(db, {
    groupId: session.groupId,
    deviceId: file.from,
    lastSyncAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastResult: 'ok',
    lastError: null,
    via: 'file',
    vector: { ...(prev?.vector ?? {}), ...payload.vector },
  });
  return result;
}

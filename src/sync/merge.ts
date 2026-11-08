// 受信した操作ログの適用: フィールド単位 LWW (docs/04-data-model.md §6)
import { CONFLICT_FIELDS, validateOp, type Op } from '../domain/schemas';
import type { DeviceMeta, FamilyDB } from '../db/db';
import { receive } from '../db/hlc';
import { getVector } from '../db/repo';

export class InvalidDataError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidDataError';
  }
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  conflicts: number;
}

type Rec = Record<string, unknown> & { id: string; groupId: string; clock: Record<string, string> };

/**
 * 操作を検証してから適用する。1 件でも不正なら何も適用せず InvalidDataError。
 * 冪等: 既に適用済みの操作は無視される。
 */
export async function applyOps(db: FamilyDB, groupId: string, rawOps: unknown[]): Promise<ApplyResult> {
  let ops: Op[];
  try {
    ops = rawOps.map((r) => validateOp(r));
  } catch {
    throw new InvalidDataError('invalid op');
  }
  for (const op of ops) if (op.groupId !== groupId) throw new InvalidDataError('foreign group');
  // HLC 順に適用 (デバイスごとの seq 順も保たれる)。base 判定を正しく行うため
  ops.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));

  const result: ApplyResult = { applied: 0, skipped: 0, conflicts: 0 };
  const tables = [...new Set(ops.map((o) => o.table))].map((t) => db.shared(t));
  await db.transaction('rw', [...tables, db.oplog, db.meta, db.conflicts], async () => {
    const vector = await getVector(db, groupId);
    const device = (await db.meta.get('device')) as DeviceMeta;
    let hlcState = device.hlc;
    const now = Date.now();
    for (const op of ops) {
      const have = vector[op.deviceId] ?? 0;
      if (op.seq <= have || op.seq !== have + 1 || op.deviceId === device.deviceId) {
        result.skipped++;
        continue;
      }
      hlcState = receive(hlcState, op.hlc, now); // 未来すぎる時刻は ClockDriftError
      const tbl = db.shared(op.table);
      const existing = (await tbl.get(op.recordId)) as unknown as Rec | undefined;
      if (existing && existing.groupId !== groupId) throw new InvalidDataError('record belongs to another group');
      const rec: Rec = existing ? { ...existing, clock: { ...existing.clock } } : { id: op.recordId, groupId, clock: {} };
      const cf: readonly string[] = CONFLICT_FIELDS[op.table] ?? [];
      for (const [field, value] of Object.entries(op.patch)) {
        const cur = rec.clock[field];
        const incomingWins = !cur || op.hlc > cur;
        if (cf.includes(field) && cur && JSON.stringify(rec[field]) !== JSON.stringify(value)) {
          // 相手は自分の値を見ていたか? / 自分は相手の値を見ていたか?
          const incomingBase = op.base?.[field] ?? null;
          // 現在のローカル値を書いた操作の base を操作ログから引く (競合フィールドは圧縮されない)
          const localOp = await db.oplog
            .where('[groupId+recordId]')
            .equals([groupId, op.recordId])
            .filter((o) => o.hlc === cur)
            .first();
          const localBase = localOp?.base?.[field] ?? null;
          const concurrent = incomingWins ? !incomingBase || incomingBase < cur : !localBase || localBase < op.hlc;
          if (concurrent) {
            await db.conflicts.add({
              id: crypto.randomUUID(),
              groupId,
              table: op.table,
              recordId: op.recordId,
              field,
              losingValue: incomingWins ? rec[field] : value,
              losingHlc: incomingWins ? cur : op.hlc,
              detectedAt: new Date().toISOString(),
              resolved: false,
            });
            result.conflicts++;
          }
        }
        if (incomingWins) {
          rec[field] = value;
          rec.clock[field] = op.hlc;
        }
      }
      await tbl.put(rec as never);
      await db.oplog.add(op);
      vector[op.deviceId] = op.seq;
      result.applied++;
    }
    await db.meta.put({ ...device, hlc: hlcState });
  });
  return result;
}

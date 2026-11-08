// 同期プロトコル (docs/06-sync-design.md §4.3)
//  hello → 相互認証 (HMAC) → 以降は AES-GCM で暗号化:
//  keys (鍵更新の配布) → vector → ops* → done → applied
import { z } from 'zod';
import { idSchema, type Op } from '../domain/schemas';
import type { FamilyDB, Peer, SyncErrorCode } from '../db/db';
import { ClockDriftError } from '../db/hlc';
import { addGroupKey, getVector, latestKey, opsSince, type Session } from '../db/repo';
import { randomBytes, safeJsonParse, toB64url } from '../lib/bytes';
import { ChannelClosedError, ChannelTimeoutError, type Channel } from './channel';
import { deriveGroupKeys, hmac, open, seal, verifyHmac } from './crypto';
import { applyOps, InvalidDataError } from './merge';

export const PROTOCOL_VERSION = 1;
const OPS_BATCH_CHARS = 12_000;
const MAX_OPS_PER_BATCH = 500;

export type Role = 'offerer' | 'answerer';

export class SyncError extends Error {
  constructor(public code: SyncErrorCode) {
    super(code);
    this.name = 'SyncError';
  }
}

export function toSyncError(e: unknown): SyncError {
  if (e instanceof SyncError) return e;
  if (e instanceof ChannelClosedError || e instanceof ChannelTimeoutError) return new SyncError('connection-lost');
  if (e instanceof InvalidDataError || e instanceof z.ZodError) return new SyncError('invalid-data');
  if (e instanceof ClockDriftError) return new SyncError('clock-drift');
  return new SyncError('unknown');
}

const vectorSchema = z.record(idSchema, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const keySchema = z.strictObject({ epoch: z.number().int().min(1).max(1_000_000), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const helloSchema = z.strictObject({
  t: z.literal('hello'),
  v: z.number().int(),
  deviceId: idSchema,
  groupId: idSchema,
  epoch: z.number().int().min(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
});
const authSchema = z.strictObject({ t: z.literal('auth'), mac: z.string().max(100) });
const encSchema = z.strictObject({ t: z.literal('enc'), n: z.number().int().min(0), iv: z.string().max(32), ct: z.string().max(5_000_000) });
const innerSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('keys'), keys: z.array(keySchema).max(1000) }),
  z.strictObject({ t: z.literal('vector'), vector: vectorSchema }),
  z.strictObject({ t: z.literal('ops'), ops: z.array(z.unknown()).max(MAX_OPS_PER_BATCH) }),
  z.strictObject({ t: z.literal('done'), count: z.number().int().min(0) }),
  z.strictObject({ t: z.literal('applied'), vector: vectorSchema }),
]);
type Inner = z.infer<typeof innerSchema>;

export interface SyncProgress {
  phase: 'auth' | 'exchange' | 'apply' | 'done';
  sent: number;
  received: number;
  total?: number;
}

export interface SyncOptions {
  db: FamilyDB;
  session: Session;
  channel: Channel;
  role: Role;
  localFingerprint: string;
  remoteFingerprint: string;
  onProgress?: (p: SyncProgress) => void;
  timeoutMs?: number;
}

export interface SyncOutcome {
  peerDeviceId: string;
  sent: number;
  received: number;
  applied: number;
  conflicts: number;
}

/** ops をメッセージサイズ上限に収まるよう分割 */
function batches(ops: Op[]): Op[][] {
  const out: Op[][] = [];
  let cur: Op[] = [];
  let size = 0;
  for (const op of ops) {
    const s = JSON.stringify(op).length;
    if (cur.length && (size + s > OPS_BATCH_CHARS || cur.length >= MAX_OPS_PER_BATCH)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(op);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function runSync(opts: SyncOptions): Promise<SyncOutcome> {
  const { db, session, channel, role } = opts;
  const timeout = opts.timeoutMs ?? 30_000;
  const groupId = session.groupId;
  let peerDeviceId: string | null = null;
  const progress = (p: SyncProgress) => opts.onProgress?.(p);

  try {
    progress({ phase: 'auth', sent: 0, received: 0 });
    const myKey = await latestKey(db, groupId);
    if (!myKey) throw new SyncError('missing-key');
    const nonce = toB64url(randomBytes(24));
    await channel.send({ t: 'hello', v: PROTOCOL_VERSION, deviceId: session.deviceId, groupId, epoch: myKey.epoch, nonce });
    const helloRaw = (await channel.recv(timeout)) as { v?: unknown };
    if (helloRaw && typeof helloRaw === 'object' && helloRaw.v !== PROTOCOL_VERSION) throw new SyncError('incompatible-version');
    const hello = helloSchema.parse(helloRaw);
    peerDeviceId = hello.deviceId;
    if (hello.groupId !== groupId) throw new SyncError('different-group');
    if (hello.deviceId === session.deviceId) throw new SyncError('auth-failed');
    const peerDevice = await db.devices.get(hello.deviceId);
    if (peerDevice && peerDevice.groupId === groupId && (peerDevice.revoked || peerDevice.deleted)) throw new SyncError('revoked');

    // 双方が持つ鍵のうち古い方の epoch で認証 (鍵更新前の端末とも同期して新しい鍵を渡すため)
    const epoch = Math.min(myKey.epoch, hello.epoch);
    const authEpochKey = await db.groupKeys.get([groupId, epoch]);
    if (!authEpochKey) throw new SyncError('missing-key');
    const keys = await deriveGroupKeys(authEpochKey.key);

    const offerer = role === 'offerer' ? { d: session.deviceId, n: nonce, f: opts.localFingerprint } : { d: hello.deviceId, n: hello.nonce, f: opts.remoteFingerprint };
    const answerer = role === 'answerer' ? { d: session.deviceId, n: nonce, f: opts.localFingerprint } : { d: hello.deviceId, n: hello.nonce, f: opts.remoteFingerprint };
    const transcript = JSON.stringify(['familyhub-auth', PROTOCOL_VERSION, groupId, epoch, offerer, answerer]);
    const otherRole: Role = role === 'offerer' ? 'answerer' : 'offerer';
    await channel.send({ t: 'auth', mac: await hmac(keys.auth, `${role}|${transcript}`) });
    const auth = authSchema.parse(await channel.recv(timeout));
    if (!(await verifyHmac(keys.auth, `${otherRole}|${transcript}`, auth.mac))) throw new SyncError('auth-failed');

    // ---- 以降は暗号化 ----
    let sendN = 0;
    let recvN = 0;
    const sendSecure = async (m: Inner) => {
      const n = sendN++;
      const sealed = await seal(keys.sync, JSON.stringify(m), `${groupId}|${session.deviceId}|${n}|${PROTOCOL_VERSION}`);
      await channel.send({ t: 'enc', n, ...sealed });
    };
    const recvSecure = async (): Promise<Inner> => {
      const f = encSchema.parse(await channel.recv(timeout));
      if (f.n !== recvN) throw new InvalidDataError('frame order');
      recvN++;
      let pt: string;
      try {
        pt = await open(keys.sync, f, `${groupId}|${hello.deviceId}|${f.n}|${PROTOCOL_VERSION}`);
      } catch {
        throw new InvalidDataError('decrypt failed');
      }
      return innerSchema.parse(safeJsonParse(pt));
    };
    const expect = async <T extends Inner['t']>(t: T): Promise<Extract<Inner, { t: T }>> => {
      const m = await recvSecure();
      if (m.t !== t) throw new InvalidDataError(`expected ${t}`);
      return m as Extract<Inner, { t: T }>;
    };

    // 鍵の配布: 相手より新しい epoch の鍵を渡す
    const allKeys = await db.groupKeys.where('[groupId+epoch]').between([groupId, hello.epoch + 1], [groupId, Infinity]).toArray();
    await sendSecure({ t: 'keys', keys: allKeys.map((k) => ({ epoch: k.epoch, key: k.key })) });
    const peerKeys = await expect('keys');
    for (const k of peerKeys.keys) {
      if (k.epoch > myKey.epoch && !(await db.groupKeys.get([groupId, k.epoch]))) await addGroupKey(db, groupId, k.epoch, k.key);
    }

    progress({ phase: 'exchange', sent: 0, received: 0 });
    await sendSecure({ t: 'vector', vector: await getVector(db, groupId) });
    const peerVector = (await expect('vector')).vector;

    const toSend = await opsSince(db, groupId, peerVector);
    let sent = 0;
    let received = 0;
    const sending = (async () => {
      for (const b of batches(toSend)) {
        await sendSecure({ t: 'ops', ops: b });
        sent += b.length;
        progress({ phase: 'exchange', sent, received, total: toSend.length });
      }
      await sendSecure({ t: 'done', count: toSend.length });
    })();

    const incoming: unknown[] = [];
    for (;;) {
      const m = await recvSecure();
      if (m.t === 'ops') {
        incoming.push(...m.ops);
        received += m.ops.length;
        progress({ phase: 'exchange', sent, received });
      } else if (m.t === 'done') {
        if (m.count !== incoming.length) throw new InvalidDataError('count mismatch');
        break;
      } else throw new InvalidDataError('unexpected message');
    }
    await sending;

    progress({ phase: 'apply', sent, received });
    const result = await applyOps(db, groupId, incoming);
    await sendSecure({ t: 'applied', vector: await getVector(db, groupId) });
    const peerFinal = (await expect('applied')).vector;

    await savePeer(db, {
      groupId,
      deviceId: hello.deviceId,
      lastSyncAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastResult: 'ok',
      lastError: null,
      via: 'webrtc',
      vector: peerFinal,
    });
    progress({ phase: 'done', sent, received });
    return { peerDeviceId: hello.deviceId, sent, received, applied: result.applied, conflicts: result.conflicts };
  } catch (e) {
    const err = toSyncError(e);
    if (peerDeviceId) await recordFailure(db, groupId, peerDeviceId, err.code).catch(() => undefined);
    channel.close();
    throw err;
  }
}

export async function savePeer(db: FamilyDB, peer: Peer): Promise<void> {
  const prev = await db.peers.get([peer.groupId, peer.deviceId]);
  await db.peers.put({ ...prev, ...peer });
}

export async function recordFailure(db: FamilyDB, groupId: string, deviceId: string, code: SyncErrorCode): Promise<void> {
  const prev = await db.peers.get([groupId, deviceId]);
  await db.peers.put({
    groupId,
    deviceId,
    lastSyncAt: prev?.lastSyncAt ?? null,
    lastAttemptAt: new Date().toISOString(),
    lastResult: 'error',
    lastError: code,
    via: prev?.via ?? 'webrtc',
    vector: prev?.vector ?? {},
  });
}

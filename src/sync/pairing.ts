// 端末ペアリング (docs/06-sync-design.md §4.2)
//  pair-hello → 確認コード (SAS) をユーザーが照合 → invite (鍵) → join → welcome → 通常同期
import { z } from 'zod';
import { colorSchema, idSchema, line, LIMITS, type Color } from '../domain/schemas';
import type { FamilyDB } from '../db/db';
import { deleteGroupData } from '../db/group';
import { addGroupKey, create, ensureDevice, getSession, listActive, setSession, update, type Session } from '../db/repo';
import type { Channel } from './channel';
import { shortAuthString } from './crypto';
import { PROTOCOL_VERSION, runSync, SyncError, toSyncError, type SyncOptions, type SyncOutcome } from './protocol';

const keySchema = z.strictObject({ epoch: z.number().int().min(1).max(1_000_000), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const pairHelloSchema = z.strictObject({ t: z.literal('pair-hello'), v: z.number().int(), deviceId: idSchema });
const sasSchema = z.strictObject({ t: z.literal('sas'), ok: z.boolean() });
const inviteSchema = z.strictObject({
  t: z.literal('invite'),
  groupId: idSchema,
  groupName: line(LIMITS.name, 1),
  keys: z.array(keySchema).min(1).max(1000),
  members: z.array(z.strictObject({ id: idSchema, name: line(LIMITS.name, 1), color: colorSchema })).max(100),
});
const joinSchema = z.strictObject({
  t: z.literal('join'),
  deviceName: line(LIMITS.name, 1),
  memberId: idSchema.nullable(),
  newMember: z.strictObject({ name: line(LIMITS.name, 1), color: colorSchema }).nullable(),
});
const welcomeSchema = z.strictObject({ t: z.literal('welcome'), memberId: idSchema });

export type Invite = z.infer<typeof inviteSchema>;
export interface JoinChoice {
  deviceName: string;
  memberId: string | null;
  newMember: { name: string; color: Color } | null;
}

interface PairBase {
  db: FamilyDB;
  channel: Channel;
  localFingerprint: string;
  remoteFingerprint: string;
  /** 確認コードを表示し、ユーザーが一致を確認したら true */
  confirmSas: (sas: string) => Promise<boolean>;
  onProgress?: SyncOptions['onProgress'];
  timeoutMs?: number;
}

async function handshake(o: PairBase, role: 'offerer' | 'answerer', deviceId: string) {
  // ユーザー操作を待つ箇所があるため、待機時間は長めに取る
  const userTimeout = 5 * 60_000;
  await o.channel.send({ t: 'pair-hello', v: PROTOCOL_VERSION, deviceId });
  const raw = (await o.channel.recv(o.timeoutMs ?? 30_000)) as { v?: unknown };
  if (raw && typeof raw === 'object' && raw.v !== PROTOCOL_VERSION) throw new SyncError('incompatible-version');
  const peer = pairHelloSchema.parse(raw);
  const sas = role === 'offerer' ? await shortAuthString(o.localFingerprint, o.remoteFingerprint) : await shortAuthString(o.remoteFingerprint, o.localFingerprint);
  const peerSas = o.channel.recv(userTimeout).then((m) => sasSchema.parse(m));
  peerSas.catch(() => undefined);
  const ok = await o.confirmSas(sas);
  await o.channel.send({ t: 'sas', ok });
  if (!ok || !(await peerSas).ok) throw new SyncError('auth-failed');
  return { peerDeviceId: peer.deviceId, userTimeout };
}

/** 既存メンバー側 (QR を最初に表示する側) */
export async function runPairInviter(o: PairBase & { session: Session }): Promise<SyncOutcome> {
  const { db, channel, session } = o;
  try {
    const { peerDeviceId, userTimeout } = await handshake(o, 'offerer', session.deviceId);
    const group = await db.groups.get(session.groupId);
    const keys = await db.groupKeys.where('[groupId+epoch]').between([session.groupId, 0], [session.groupId, Infinity]).toArray();
    const members = await listActive(db, session.groupId, 'members');
    await channel.send({
      t: 'invite',
      groupId: session.groupId,
      groupName: group?.name ?? '家族',
      keys: keys.map((k) => ({ epoch: k.epoch, key: k.key })),
      members: members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
    });
    const join = joinSchema.parse(await channel.recv(userTimeout));
    let memberId = join.memberId;
    if (memberId && !members.some((m) => m.id === memberId)) throw new SyncError('invalid-data');
    if (!memberId) {
      if (!join.newMember) throw new SyncError('invalid-data');
      memberId = await create(db, session, 'members', { name: join.newMember.name, color: join.newMember.color, role: 'adult' });
    }
    const existing = await db.devices.get(peerDeviceId);
    if (existing && existing.groupId !== session.groupId) throw new SyncError('invalid-data');
    if (existing) await update(db, session, 'devices', peerDeviceId, { name: join.deviceName, memberId, revoked: false });
    else await create(db, session, 'devices', { name: join.deviceName, memberId, revoked: false }, peerDeviceId);
    await channel.send({ t: 'welcome', memberId });
    return await runSync({ ...o, session, role: 'offerer' });
  } catch (e) {
    channel.close();
    throw toSyncError(e);
  }
}

/** 新しく参加する側 (QR を読み取る側) */
export async function runPairJoiner(o: PairBase & { chooseMember: (invite: Invite) => Promise<JoinChoice> }): Promise<SyncOutcome> {
  const { db, channel } = o;
  try {
    const device = await ensureDevice(db);
    const { userTimeout } = await handshake(o, 'answerer', device.deviceId);
    const invite = inviteSchema.parse(await channel.recv(userTimeout));
    const choice = await o.chooseMember(invite);
    await channel.send({ t: 'join', ...choice });
    const welcome = welcomeSchema.parse(await channel.recv(o.timeoutMs ?? 30_000));
    // 別グループのデータが残っていれば削除 (UI で事前に確認済み)
    const prev = await getSession(db);
    if (prev && prev.groupId !== invite.groupId) await deleteGroupData(db, prev.groupId);
    for (const k of invite.keys) await addGroupKey(db, invite.groupId, k.epoch, k.key);
    await setSession(db, invite.groupId, welcome.memberId);
    const session: Session = { groupId: invite.groupId, memberId: welcome.memberId, deviceId: device.deviceId };
    return await runSync({ ...o, session, role: 'answerer' });
  } catch (e) {
    channel.close();
    throw toSyncError(e);
  }
}

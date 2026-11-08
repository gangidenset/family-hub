import { describe, expect, it } from 'vitest';
import { BackupError, exportBackup, parseBackup, restoreBackup } from '../../src/backup/backup';
import { create, getSession, getVector, listActive } from '../../src/db/repo';
import { createGroup } from '../../src/db/group';
import { exportSyncFile, importSyncFile } from '../../src/sync/file';
import { decodeDescription, encodeDescription, InvalidCodeError } from '../../src/sync/codec';
import { newDb, twoDevices } from './helpers';

const task = (title: string) => ({ title, assigneeId: null, dueDate: null, done: false, doneAt: null, doneBy: null, categoryId: null, note: '' });

async function setup() {
  const db = newDb();
  const s = await createGroup(db, { groupName: '佐藤家', memberName: '母', memberColor: 'teal', deviceName: 'A' });
  await create(db, s, 'tasks', task('洗濯'));
  await create(db, s, 'memos', { title: 'Wi-Fi', body: 'SSID: home', categoryId: null, pinned: true });
  return { db, s };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as BackupError).code;
  }
};

describe('バックアップと復元', () => {
  it('書き出し → 検証 → 別端末へ復元できる', async () => {
    const { db, s } = await setup();
    const text = await exportBackup(db, s.groupId, s.memberId);
    const parsed = await parseBackup(text);
    expect(parsed.groupName).toBe('佐藤家');
    expect(parsed.counts.tasks).toBe(1);
    expect(parsed.counts.memos).toBe(1);
    expect(parsed.keys).toBeNull(); // 平文バックアップには鍵を含めない
    expect(text).not.toContain((await db.groupKeys.toArray())[0]!.key);

    const other = newDb();
    await restoreBackup(other, parsed, null);
    const rs = (await getSession(other))!;
    expect(rs.groupId).toBe(s.groupId);
    expect((await listActive(other, rs.groupId, 'tasks')).map((t) => t.title)).toEqual(['洗濯']);
    // 復元後の新しい変更が正しく記録される
    await create(other, rs, 'tasks', task('買い出し'));
    expect((await getVector(other, rs.groupId))[rs.deviceId]).toBeGreaterThan(0);
  });

  it('パスフレーズ付きバックアップは鍵を含み、誤ったパスフレーズでは開けない', async () => {
    const { db, s } = await setup();
    const text = await exportBackup(db, s.groupId, s.memberId, 'correct horse');
    expect(text).not.toContain('洗濯');
    expect(await code(parseBackup(text))).toBe('needs-passphrase');
    expect(await code(parseBackup(text, 'wrong'))).toBe('wrong-passphrase');
    const parsed = await parseBackup(text, 'correct horse');
    expect(parsed.keys).toHaveLength(1);
  }, 30_000);

  it('不正なバックアップを拒否する', async () => {
    const { db, s } = await setup();
    const good = await exportBackup(db, s.groupId, s.memberId);
    const obj = JSON.parse(good);
    expect(await code(parseBackup('not json'))).toBe('not-json');
    expect(await code(parseBackup('{"format":"other"}'))).toBe('not-backup');
    expect(await code(parseBackup(JSON.stringify({ ...obj, formatVersion: 99 })))).toBe('newer-version');
    // 改ざん (チェックサム不一致)
    expect(await code(parseBackup(good.replace('洗濯', '盗難')))).toBe('checksum');
    // 型違反のレコード (チェックサムも再計算した巧妙な改ざん)
    const { sha256Hex } = await import('../../src/sync/crypto');
    obj.data.tasks[0].title = 123;
    obj.checksum = 'sha256:' + (await sha256Hex(JSON.stringify([obj.data, obj.oplog])));
    expect(await code(parseBackup(JSON.stringify(obj)))).toBe('invalid-record');
    // プロトタイプ汚染
    expect(await code(parseBackup(good.replace('{"format"', '{"__proto__":{"polluted":true},"format"')))).toBe('not-json');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // 未知のフィールド
    expect(await code(parseBackup(JSON.stringify({ ...JSON.parse(good), extra: 1 })))).toBe('not-backup');
  });

  it('データの全削除後に復元できる', async () => {
    const { db, s } = await setup();
    const text = await exportBackup(db, s.groupId, s.memberId);
    const { wipeAll } = await import('../../src/db/group');
    await wipeAll(db);
    expect(await db.tasks.count()).toBe(0);
    expect(await getSession(db)).toBeNull();
    await restoreBackup(db, await parseBackup(text), null);
    expect(await db.tasks.count()).toBe(1);
  });
});

describe('暗号化同期ファイル', () => {
  it('ファイル経由で取り込め、何度取り込んでも重複しない', async () => {
    const { a, b, sa, sb } = await twoDevices();
    await create(a, sa, 'tasks', task('掃除'));
    const { text } = await exportSyncFile(a, sa);
    expect(text).not.toContain('掃除');
    const r1 = await importSyncFile(b, sb, text);
    const r2 = await importSyncFile(b, sb, text);
    expect(r1.applied).toBeGreaterThan(0);
    expect(r2.applied).toBe(0);
    expect((await listActive(b, sb.groupId, 'tasks')).map((t) => t.title)).toEqual(['掃除']);
  });

  it('改ざん・別グループのファイルは拒否', async () => {
    const { a, b, sa, sb } = await twoDevices();
    const { text } = await exportSyncFile(a, sa);
    const obj = JSON.parse(text);
    obj.ct = obj.ct.slice(0, -4) + (obj.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(importSyncFile(b, sb, JSON.stringify(obj))).rejects.toMatchObject({ code: 'auth-failed' });
    await expect(importSyncFile(b, { ...sb, groupId: crypto.randomUUID() }, text)).rejects.toMatchObject({ code: 'different-group' });
    await expect(importSyncFile(b, sb, 'garbage')).rejects.toMatchObject({ code: 'invalid-data' });
  });
});

describe('接続コード (QR)', () => {
  const sdp = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=ice-ufrag:abcd', 'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=fingerprint:sha-256 ' + Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':'),
    'a=setup:actpass',
    'a=candidate:1 1 udp 2113937151 6e5d5238-7dba-42df-8d90-704ceccab34d.local 57748 typ host generation 0',
    'a=candidate:2 1 udp 2113937151 192.168.1.20 50000 typ host generation 0',
    'a=candidate:3 1 udp 2113937151 fe80::1 50001 typ host generation 0',
  ].join('\r\n');

  it('往復で必要な情報が保たれる', () => {
    const c = encodeDescription({ type: 'offer', sdp }, new TextEncoder().encode('{"m":"s"}'));
    expect(c.startsWith('FH1:')).toBe(true);
    expect(c.length).toBeLessThan(250);
    const { description, extra } = decodeDescription(c);
    expect(description.type).toBe('offer');
    expect(description.sdp).toContain('a=ice-pwd:abcdefghijklmnopqrstuvwx');
    expect(description.sdp).toContain('6e5d5238-7dba-42df-8d90-704ceccab34d.local 57748');
    expect(description.sdp).toContain('192.168.1.20 50000');
    expect(description.sdp).toContain('fe80:0:0:0:0:0:0:1 50001');
    expect(new TextDecoder().decode(extra)).toBe('{"m":"s"}');
  });

  it('不正なコードを拒否する', () => {
    expect(() => decodeDescription('hello')).toThrow(InvalidCodeError);
    expect(() => decodeDescription('FH1:!!!')).toThrow(InvalidCodeError);
    expect(() => decodeDescription('FH1:AQAA')).toThrow(InvalidCodeError);
    const inj = 'FH1:' + Buffer.from([1, 0, 0, 6, ...Buffer.from('ab\r\na='), 24, ...Buffer.from('x'.repeat(24))]).toString('base64url');
    expect(() => decodeDescription(inj)).toThrow(InvalidCodeError);
    expect(() => decodeDescription('FH1:' + 'A'.repeat(2000))).toThrow(InvalidCodeError);
  });
});

// Phase 1 技術検証スクリプト
// 2つの独立した Chromium プロセスを「別端末」に見立て、
// 圧縮 SDP → QR 画像化 → QR デコード → 相手へ入力 という手順で
// STUN/TURN/シグナリングサーバーなしに WebRTC データチャネルが張れるかを確認する。
//
// 注意: 同一マシン上での検証であり、実機 (Android/iPhone) 間・Wi-Fi 越しの
// 動作を保証するものではない。結果の解釈は docs/06-sync-design.md を参照。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('.', import.meta.url));

const server = http.createServer(async (req, res) => {
  try {
    const path = join(root, new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(root)) throw new Error('forbidden');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/page.html`;

/** 文字列を QR (誤り訂正 M) にし、画素化して jsQR で読み戻す (カメラ読み取りの代替) */
function qrRoundTrip(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const scale = 4, quiet = 4, n = qr.modules.size, size = (n + quiet * 2) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!qr.modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  const decoded = jsQR(px, size, size);
  if (!decoded || decoded.data !== text) throw new Error('QR round trip failed');
  return { text: decoded.data, version: qr.version, modules: n };
}

async function scenario(name, launchArgs, { tamper = false } = {}) {
  const a = await chromium.launch({ args: launchArgs });
  const b = await chromium.launch({ args: launchArgs });
  const pa = await (await a.newContext()).newPage();
  const pb = await (await b.newContext()).newPage();
  await Promise.all([pa.goto(url), pb.goto(url)]);
  const t0 = Date.now();
  try {
    // 招待情報 (グループID + 32byte 鍵の base64url 想定) を同梱
    const invite = 'g:7f3a9c1e2b4d|k:' + 'A'.repeat(43);
    const offer = await pa.evaluate((x) => window.spike.createOffer(x), invite);
    const qr1 = qrRoundTrip(offer.code);
    let offerCode = qr1.text;
    if (tamper) {
      // 中間者が SDP のフィンガープリントを差し替えたケースを模擬 (1bit 反転)
      const bytes = Buffer.from(offerCode, 'base64url');
      const fpOffset = 3 + 1 + bytes[3] + 1 + bytes[4 + bytes[3]];
      bytes[fpOffset] ^= 0x01;
      offerCode = bytes.toString('base64url');
    }
    const answer = await pb.evaluate((c) => window.spike.acceptOffer(c), offerCode);
    const qr2 = qrRoundTrip(answer.code);
    await pa.evaluate((c) => window.spike.acceptAnswer(c), qr2.text);
    const [openA, openB] = await Promise.all([
      pa.evaluate(() => window.spike.waitOpen(8000)),
      pb.evaluate(() => window.spike.waitOpen(8000)),
    ]);
    let echo = false;
    if (openA && openB) {
      await pa.evaluate(() => window.spike.send('hello from A'));
      await pb.evaluate(() => window.spike.send('hello from B'));
      await pa.waitForTimeout(300);
      const ra = await pa.evaluate(() => window.spike.received());
      const rb = await pb.evaluate(() => window.spike.received());
      echo = ra.includes('hello from B') && rb.includes('hello from A');
    }
    return {
      name,
      connected: openA && openB && echo,
      ms: Date.now() - t0,
      inviteDelivered: answer.extra === invite,
      candidates: offer.candidates.map((c) => c.split(' ').slice(4, 6).join(':')),
      rawSdpBytes: { offer: offer.rawSdpLength, answer: answer.rawSdpLength },
      codeChars: { offer: offer.code.length, answer: answer.code.length },
      qrVersion: { offer: qr1.version, answer: qr2.version },
      stateA: await pa.evaluate(() => window.spike.state()),
    };
  } finally {
    await a.close(); await b.close();
  }
}

async function inputValidation() {
  const br = await chromium.launch();
  const p = await br.newPage();
  await p.goto(url);
  const cases = {
    garbage: 'not!!base64',
    truncated: 'AQAA',
    sdpInjection: Buffer.from([1, 0, 0, 6, ...Buffer.from('ab\r\na='), 24, ...Buffer.from('x'.repeat(24))]).toString('base64url'),
  };
  const out = {};
  for (const [k, v] of Object.entries(cases)) out[k] = await p.evaluate((c) => window.spike.decode(c), v);
  await br.close();
  return out;
}

const results = [];
results.push(await scenario('default (mDNS host candidates)', []));
results.push(await scenario('mDNS obfuscation disabled', ['--disable-features=WebRtcHideLocalIpsWithMdns']));
results.push(await scenario('tampered fingerprint (MITM) — must NOT connect', ['--disable-features=WebRtcHideLocalIpsWithMdns'], { tamper: true }));
const validation = await inputValidation();
server.close();
console.log(JSON.stringify({ results, validation }, null, 2));

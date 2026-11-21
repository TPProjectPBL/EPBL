#!/usr/bin/env node
/**
 * 摄像头泄漏检查：在工作台里连续切换 DB 里的 4 个模块 20 次，
 * 统计 <video> 元素数量与宿主摄像头状态。
 *
 * 用法：
 *   node scripts/check-camera-leaks.mjs [--cdp http://127.0.0.1:9228] [--url http://127.0.0.1:8125/workbench/] [--rounds 20]
 *
 * 判定：
 *   - 每轮 maxVideos <= 1（宿主 1 路，或独占模块 1 路）
 *   - 结束时宿主 camera=false 或仍只有 1 路
 * 退出码 0 通过，1 失败。
 */

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const CDP = arg('--cdp', 'http://127.0.0.1:9228');
const URL_WB = arg('--url', 'http://127.0.0.1:8125/workbench/');
const ROUNDS = Number(arg('--rounds', '20'));
const MODULES = ['dual-test', 'gaze-heatmap', 'draw', 'air-runner'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`${CDP}/json`);
  return r.json();
}

async function connect() {
  const list = await targets();
  const pages = list.filter((t) => t.type === 'page' && !/overlay/.test(t.url) && !/^chrome/.test(t.url));
  const page =
    pages.find((t) => /\/workbench\//.test(t.url)) ||
    pages.find((t) => /^about:blank/.test(t.url)) ||
    pages[0];
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('ws error'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send };
}

(async () => {
  const { ws, send } = await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_WB });
  await sleep(2500);

  const probe = async () => {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{
        const host = window.__epblGazeHost ? window.__epblGazeHost.getStatus() : null;
        // 只算「真的挂着流」的 video：WebGazer 之类会预建空 video 元素，不代表有 track
        const live = (doc) => [...doc.querySelectorAll('video')].filter((v) => v.srcObject).length;
        const all = (doc) => doc.querySelectorAll('video').length;
        const vids = live(document);
        const vidsAll = all(document);
        const frames = [...document.querySelectorAll('iframe')];
        let inner = 0, innerAll = 0;
        for (const f of frames) { try { inner += live(f.contentWindow.document); innerAll += all(f.contentWindow.document); } catch(e){} }
        return JSON.stringify({ vids, vidsAll, inner, innerAll, host });
      })()`,
      returnByValue: true,
    });
    return JSON.parse(r.result.value);
  };

  let maxVideos = 0;
  let worst = null;
  const rows = [];
  for (let i = 0; i < ROUNDS; i++) {
    const m = MODULES[i % MODULES.length];
    await send('Runtime.evaluate', { expression: `location.hash = '#/${m}'` });
    await sleep(700);
    const p = await probe();
    const total = p.vids + p.inner;
    rows.push({ round: i + 1, module: m, liveTracks: total, hostVideos: p.vids, innerVideos: p.inner, hostEls: p.vidsAll, innerEls: p.innerAll, camera: p.host && p.host.camera, subs: p.host && p.host.subscribers, exclusive: p.host && p.host.exclusive });
    if (total > maxVideos) {
      maxVideos = total;
      worst = rows[rows.length - 1];
    }
  }

  // 回一个订阅型模块，确认宿主能恢复推理
  await send('Runtime.evaluate', { expression: `location.hash = '#/air-runner'` });
  await sleep(1200);
  const end = await probe();

  console.log(JSON.stringify({ rounds: ROUNDS, maxLiveTracks: maxVideos, worst, end: { liveTracks: end.vids + end.inner, host: end.host }, rows }, null, 2));

  const pass = maxVideos <= 1;
  ws.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('check failed:', e.message);
  process.exit(2);
});

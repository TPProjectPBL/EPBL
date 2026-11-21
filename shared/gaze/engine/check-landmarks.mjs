#!/usr/bin/env node
/**
 * 关键点索引一致性检查：Tasks FaceLandmarker（新）vs legacy FaceMesh（旧）。
 *
 * 比较 468/473（左右虹膜）与 33/133/263/362（左右眼角）的归一化坐标，
 * 确认两者是同一套 478 点拓扑，且索引语义一致。
 *
 * 用法（Node，通过 CDP 在已打开的页面里执行）：
 *   node shared/gaze/engine/check-landmarks.mjs --image .deepworks/tmp/portrait.jpg
 *   node shared/gaze/engine/check-landmarks.mjs            # 无图 → canvas 合成（只会得到 no-face）
 *
 * 也可在页面 console 里直接 import（纯浏览器模块，无 node 依赖）：
 *   const { runCheckInPage } = await import('/shared/gaze/engine/check-in-page.js');
 *   await runCheckInPage({ imageUrl: '/some/face.jpg' });
 *
 * 环境变量：
 *   GAZE_CDP   CDP 端点，默认 http://127.0.0.1:9228
 *   GAZE_BASE  页面内模块基址，默认 <target origin>/shared/gaze/engine/
 *              （静态服务根不是 EPBL-latest 时需显式指定）
 */
import fs from 'node:fs';
import path from 'node:path';
import { IDX, LABEL, runCheckInPage } from './check-in-page.js';

export { IDX, LABEL, runCheckInPage };

/* ------------------------------- Node CLI ------------------------------- */

async function pickTarget() {
  const cdp = process.env.GAZE_CDP || 'http://127.0.0.1:9228';
  const list = await (await fetch(`${cdp}/json/list`)).json();
  const pages = list.filter(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && /^https?:/.test(t.url || '')
  );
  const target =
    pages.find((t) => t.url.includes('air-runner')) ||
    pages.find((t) => !t.url.includes(':5173') && !t.url.includes('deepworks'));
  if (!target) {
    throw new Error(
      '没有可用的浏览器页面，请先打开 http://127.0.0.1:8125/eye-page-turner/demo/air-runner/'
    );
  }
  if (process.env.GAZE_VERBOSE) console.error('[check-landmarks] target: ' + target.url);
  return target;
}

async function cdpEvaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const id = 1;
  const payload = {
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  };
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP evaluate 超时（30s）')), 30000);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        clearTimeout(timer);
        resolve(msg);
      }
    };
    ws.send(JSON.stringify(payload));
  });
  ws.close();

  const res = reply.result || {};
  if (res.exceptionDetails) {
    throw new Error(
      '页面执行异常：' +
        (res.exceptionDetails.text || '') +
        ' ' +
        (res.exceptionDetails.exception?.description || '')
    );
  }
  return res.result ? res.result.value : null;
}

function imageToDataUrl(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(5) : '-';
}

function print(result, imageNote) {
  console.log('=== 测试图 ===');
  console.log(imageNote);
  console.log('\n=== Tasks FaceLandmarker（新）===');
  if (result.tasks.ok) {
    console.log(`count=${result.tasks.count} delegate=${result.tasks.delegate} model=${result.tasks.modelSource}`);
    for (const k of Object.keys(IDX)) {
      const p = result.tasks.points[k];
      console.log(`  ${String(IDX[k]).padStart(3)} ${LABEL[IDX[k]]}  x=${fmt(p && p.x)} y=${fmt(p && p.y)} z=${fmt(p && p.z)}`);
    }
  } else {
    console.log('  未取到关键点：' + (result.tasks.error || result.tasks.reason));
    if (result.tasks.error && result.tasks.error.includes('创建失败')) {
      console.log('  提示：连续多次运行会耗尽页面 WebGL 上下文，刷新页面后重跑即可。');
    }
  }

  console.log('\n=== legacy FaceMesh（旧）===');
  if (!result.legacy.available) console.log('  页面未加载 window.FaceMesh（CDN 未就绪）');
  else if (result.legacy.ok) {
    console.log(`count=${result.legacy.count}`);
    for (const k of Object.keys(IDX)) {
      const p = result.legacy.points[k];
      console.log(`  ${String(IDX[k]).padStart(3)} ${LABEL[IDX[k]]}  x=${fmt(p && p.x)} y=${fmt(p && p.y)} z=${fmt(p && p.z)}`);
    }
  } else {
    console.log('  未取到关键点：' + (result.legacy.error || result.legacy.reason));
  }

  if (result.delta && Object.keys(result.delta).length) {
    console.log('\n=== 坐标差（归一化欧氏距离）===');
    let worst = 0;
    for (const k of Object.keys(IDX)) {
      const d = result.delta[k];
      if (d !== null) worst = Math.max(worst, d);
      console.log(`  ${String(IDX[k]).padStart(3)} ${LABEL[IDX[k]]}  delta=${fmt(d)}`);
    }
    console.log(`  最大差=${fmt(worst)}  ${worst <= 0.02 ? '（同拓扑，索引一致）' : '（差异偏大，需人工复核）'}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let imagePath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--image') imagePath = args[i + 1];
  }

  let imageUrl = '';
  let note = '未提供 --image，使用 canvas 合成图（不含真实人脸，预期 no-face）';
  if (imagePath) {
    const abs = path.resolve(imagePath);
    if (!fs.existsSync(abs)) {
      console.error('图片不存在：' + abs);
      process.exit(2);
    }
    imageUrl = imageToDataUrl(abs);
    note = abs + '（' + Math.round(fs.statSync(abs).size / 1024) + ' KB）';
  }

  const target = await pickTarget();
  const base = process.env.GAZE_BASE || new URL('/shared/gaze/engine/', target.url).href;
  const expression =
    `(async()=>{const m=await import(${JSON.stringify(base + 'check-in-page.js')});` +
    `return await m.runCheckInPage({imageUrl:${JSON.stringify(imageUrl)}});})()`;

  const result = await cdpEvaluate(target, expression);
  print(result, note);

  if (!result.tasks.ok) process.exit(1);
}

const isNode =
  typeof process !== 'undefined' &&
  process.argv &&
  process.argv[1] &&
  (process.argv[1].endsWith('check-landmarks.mjs') || process.argv[1].endsWith('check-landmarks.js'));
if (isNode) {
  main().catch((err) => {
    console.error('[check-landmarks] ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}

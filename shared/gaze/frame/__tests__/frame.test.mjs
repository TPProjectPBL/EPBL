#!/usr/bin/env node
/**
 * frame.js 单元测试（Node，纯函数 + 伪造 window / rect）。
 *
 * 覆盖：
 *   1) 整窗 = 容器（恒等）
 *   2) iframe 左 240 / 顶 52 的偏移
 *   3) iframe 内二级容器（容器自身再偏移）
 *   4) 越界点 outside 标记 + clamped 裁剪
 *   5) rect 宽高为 0 → null
 *   6) hostWindow 不可访问 → {code:'CROSS_ORIGIN'}
 *   7) client ↔ page 往返、page ↔ container 往返
 *   8) frameContext 诊断字段
 *
 * 运行：node shared/gaze/frame/__tests__/frame.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gazeRoot = path.resolve(here, '..', '..'); // shared/gaze
const tmp = path.resolve(gazeRoot, '..', '..', '..', '.deepworks', 'tmp', 'frame-test');

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const src = fs.readFileSync(path.join(gazeRoot, 'frame.js'), 'utf8');
fs.writeFileSync(path.join(tmp, 'frame.mjs'), src);

const F = await import(pathToFileURL(path.join(tmp, 'frame.mjs')).href);

/* ---------------------------------------------------------------- 伪造环境 */

function makeWin({ w = 1440, h = 900, dpr = 2, scrollX = 0, scrollY = 0, scale = 1, offsetLeft = 0, offsetTop = 0, frameElement = null } = {}) {
  const win = {
    innerWidth: w,
    innerHeight: h,
    devicePixelRatio: dpr,
    scrollX,
    scrollY,
    visualViewport: { scale, offsetLeft, offsetTop, width: w * scale, height: h * scale },
    frameElement,
  };
  win.document = { defaultView: win };
  return win;
}

function makeFrameEl({ left = 0, top = 0, width = 1200, height = 848 } = {}) {
  return { getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) };
}

function makeEl({ left = 0, top = 0, width = 100, height = 100 } = {}, elWin) {
  return {
    ownerDocument: { defaultView: elWin },
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
  };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ---------------------------------------------------------------- 场景 */

// 独立页：整窗 1000×800
const soloWin = makeWin({ w: 1000, h: 800, dpr: 1, scale: 1 });
globalThis.window = soloWin;

// iframe：host 1440×900，iframe 在 left 240 / top 52，尺寸 1200×848
const parentWin = makeWin({ w: 1440, h: 900, dpr: 2 });
const frameRect = { left: 240, top: 52, width: 1200, height: 848 };
const iframeWin = makeWin({ w: 1200, h: 848, dpr: 2, frameElement: makeFrameEl(frameRect) });

const cases = [];
function test(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (e) {
    cases.push({ name, ok: false, error: e });
  }
}

/* ---------------------------------------------------------------- 1. 恒等 */

test('整窗 = 容器：恒等且越界标记为 false', () => {
  globalThis.window = soloWin;
  const el = makeEl({ left: 0, top: 0, width: 1000, height: 800 }, soloWin);
  for (const p of [{ x: 0, y: 0 }, { x: 0.25, y: 0.5 }, { x: 1, y: 1 }, { x: 0.73, y: 0.11 }]) {
    const r = F.containerFromPage(p, el, { hostWindow: soloWin });
    assert.ok(r, '不应返回 null');
    assert.ok(near(r.raw.x, p.x) && near(r.raw.y, p.y), JSON.stringify({ p, raw: r.raw }));
    assert.equal(r.outside, false);
  }
});

test('整窗内偏移容器：左上 200/100，尺寸 600/400', () => {
  globalThis.window = soloWin;
  const el = makeEl({ left: 200, top: 100, width: 600, height: 400 }, soloWin);
  // PAGE_NORM 0.5,0.5 → 布局 500,400 → 容器内 300,300 → 0.5,0.75
  const r = F.containerFromPage({ x: 0.5, y: 0.5 }, el, { hostWindow: soloWin });
  assert.ok(near(r.raw.x, 0.5) && near(r.raw.y, 0.75), JSON.stringify(r.raw));
  assert.equal(r.outside, false);
});

/* ---------------------------------------------------------------- 2. iframe 偏移 */

test('iframe 左 240 / 顶 52：PAGE_NORM 0.5,0.5 → 容器 0.475,0.53', () => {
  globalThis.window = iframeWin;
  const el = makeEl({ left: 100, top: 80, width: 800, height: 600 }, iframeWin);
  const r = F.containerFromPage({ x: 0.5, y: 0.5 }, el, { hostWindow: parentWin });
  // 720-240=480 → 480-100=380 → 380/800=0.475
  // 450-52=398 → 398-80=318 → 318/600=0.53
  assert.ok(near(r.raw.x, 0.475) && near(r.raw.y, 0.53), JSON.stringify(r.raw));
  assert.equal(r.outside, false);
});

test('iframe 内 clientFromPage 扣掉 iframe 偏移', () => {
  globalThis.window = iframeWin;
  const c = F.clientFromPage({ x: 0.5, y: 0.5 }, parentWin);
  assert.ok(near(c.x, 480) && near(c.y, 398), JSON.stringify(c));
});

/* ---------------------------------------------------------------- 3. 二级容器 */

test('iframe 内二级容器：容器再偏移 150/120，尺寸 400/300', () => {
  globalThis.window = iframeWin;
  const el = makeEl({ left: 150, top: 120, width: 400, height: 300 }, iframeWin);
  const r = F.containerFromPage({ x: 0.5, y: 0.5 }, el, { hostWindow: parentWin });
  // local 480,398 → 330,278 → 0.825, 0.92666...
  assert.ok(near(r.raw.x, 330 / 400), JSON.stringify(r.raw));
  assert.ok(near(r.raw.y, 278 / 300));
  assert.equal(r.outside, false);
});

test('pageFromContainer 是 containerFromPage 的逆运算', () => {
  globalThis.window = iframeWin;
  const el = makeEl({ left: 150, top: 120, width: 400, height: 300 }, iframeWin);
  const p = { x: 0.6, y: 0.35 };
  const q = F.containerFromPage(p, el, { hostWindow: parentWin });
  const back = F.pageFromContainer(q.raw, el, { hostWindow: parentWin });
  assert.ok(near(back.x, p.x, 1e-12) && near(back.y, p.y, 1e-12), JSON.stringify(back));
});

/* ---------------------------------------------------------------- 4. 越界 */

test('越界点：outside=true 且 clamped 落在 0..1', () => {
  globalThis.window = iframeWin;
  const el = makeEl({ left: 100, top: 80, width: 800, height: 600 }, iframeWin);
  const hi = F.containerFromPage({ x: 1.4, y: 0.5 }, el, { hostWindow: parentWin });
  assert.equal(hi.outside, true);
  assert.equal(hi.clamped.x, 1);
  const lo = F.containerFromPage({ x: 0.5, y: -0.3 }, el, { hostWindow: parentWin });
  assert.equal(lo.outside, true);
  assert.equal(lo.clamped.y, 0);
  assert.ok(lo.raw.y < 0);
});

/* ---------------------------------------------------------------- 5. 零尺寸 */

test('容器 rect 宽高为 0 → null', () => {
  globalThis.window = soloWin;
  const zeroW = makeEl({ left: 0, top: 0, width: 0, height: 400 }, soloWin);
  const zeroH = makeEl({ left: 0, top: 0, width: 400, height: 0 }, soloWin);
  assert.equal(F.containerFromPage({ x: 0.5, y: 0.5 }, zeroW, { hostWindow: soloWin }), null);
  assert.equal(F.containerFromPage({ x: 0.5, y: 0.5 }, zeroH, { hostWindow: soloWin }), null);
  assert.equal(F.pageFromContainer({ x: 0.5, y: 0.5 }, zeroW, { hostWindow: soloWin }), null);
});

test('iframe rect 宽高为 0 → null', () => {
  const broken = makeWin({ w: 1200, h: 848, frameElement: makeFrameEl({ left: 0, top: 0, width: 0, height: 0 }) });
  globalThis.window = broken;
  const el = makeEl({ left: 0, top: 0, width: 400, height: 300 }, broken);
  assert.equal(F.containerFromPage({ x: 0.5, y: 0.5 }, el, { hostWindow: parentWin }), null);
  assert.equal(F.clientFromPage({ x: 0.5, y: 0.5 }, parentWin), null);
  assert.equal(F.frameContext(parentWin), null);
});

test('host 视口为 0 → null', () => {
  globalThis.window = soloWin;
  const empty = makeWin({ w: 0, h: 0 });
  assert.equal(F.pageFromClient(10, 10, empty), null);
});

/* ---------------------------------------------------------------- 6. 跨域 */

test('host 属性不可读 → 抛 {code:CROSS_ORIGIN}', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'innerWidth', {
    get() {
      const e = new Error('Blocked a frame with origin');
      e.name = 'SecurityError';
      throw e;
    },
  });
  let caught = null;
  try {
    F.pageFromClient(10, 10, hostile);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, '必须抛错');
  assert.equal(caught.code, 'CROSS_ORIGIN');
});

/* ---------------------------------------------------------------- 7. 往返 */

test('client ↔ page 往返（scale=1）', () => {
  globalThis.window = soloWin;
  const p = F.pageFromClient(250, 600, soloWin);
  assert.ok(near(p.x, 0.25) && near(p.y, 0.75), JSON.stringify(p));
  const c = F.clientFromPage(p, soloWin);
  assert.ok(near(c.x, 250, 1e-9) && near(c.y, 600, 1e-9), JSON.stringify(c));
});

test('visualViewport scale=2：client 400 → 布局 200', () => {
  globalThis.window = soloWin;
  const zoomed = makeWin({ w: 1000, h: 800, scale: 2 });
  const p = F.pageFromClient(400, 400, zoomed);
  assert.ok(near(p.x, 0.2) && near(p.y, 0.25), JSON.stringify(p));
  const c = F.clientFromPage(p, zoomed);
  assert.ok(near(c.x, 400) && near(c.y, 400));
});

/* ---------------------------------------------------------------- 8. frameContext */

test('frameContext：iframe 内返回偏移与 dpr/scroll', () => {
  globalThis.window = iframeWin;
  const ctx = F.frameContext(parentWin);
  assert.equal(ctx.inIframe, true);
  assert.equal(ctx.hostW, 1440);
  assert.equal(ctx.hostH, 900);
  assert.deepEqual(ctx.rect, { left: 240, top: 52, width: 1200, height: 848 });
  assert.equal(ctx.dpr, 2);
  assert.equal(ctx.scale, 1);
});

test('frameContext：独立页 rect 等于视口', () => {
  globalThis.window = soloWin;
  const ctx = F.frameContext(soloWin);
  assert.equal(ctx.inIframe, false);
  assert.deepEqual(ctx.rect, { left: 0, top: 0, width: 1000, height: 800 });
});

/* ---------------------------------------------------------------- 输出 */

let failed = 0;
for (const c of cases) {
  if (c.ok) console.log(`  ok   ${c.name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${c.name}`);
    console.log(`       ${c.error && c.error.message}`);
  }
}
console.log(failed ? `\nFAIL frame (${failed}/${cases.length})` : `\nPASS frame (${cases.length} cases)`);
process.exit(failed ? 1 : 0);

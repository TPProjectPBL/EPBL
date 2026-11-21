#!/usr/bin/env node
/**
 * Calibrator 单元测试（Node，无浏览器）。
 *
 * 用固定种子的合成 landmarks 跑完整 9 点一轮，断言：
 *   1) 9 个样本全部产出
 *   2) model.ok === true
 *   3) quality.avgErr 在 0..0.1
 *   4) 同种子再跑一次，模型 JSON 完全一致（确定性）
 *
 * 运行：node shared/gaze/calibrate/__tests__/calibrator.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gazeRoot = path.resolve(here, '..', '..'); // shared/gaze
const tmp = path.resolve(gazeRoot, '..', '..', '..', '.deepworks', 'tmp', 'calibrator-test');

function copyAsMjs(srcDir, dstDir, rename) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    let src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    src = src.replace(/from '(\.[^']+)\.js'/g, "from '$1.mjs'");
    const out = rename ? rename(f) : f.replace(/\.js$/, '.mjs');
    fs.writeFileSync(path.join(dstDir, out), src);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
copyAsMjs(path.join(gazeRoot, 'core'), path.join(tmp, 'core'));
copyAsMjs(gazeRoot, tmp);
copyAsMjs(path.join(gazeRoot, 'calibrate'), path.join(tmp, 'calibrate'));

const { Calibrator } = await import(pathToFileURL(path.join(tmp, 'calibrate', 'calibrator.mjs')).href);
const { simLandmarksFor } = await import(pathToFileURL(path.join(tmp, 'core', 'index.mjs')).href);

// Calibrator 用 window.innerWidth/Height 把容器坐标换算成 PAGE_NORM
globalThis.window = { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 };

const container = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 }),
  ownerDocument: null,
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOnce(seed, opts = {}) {
  const rnd = mulberry32(seed);
  const aspect = 4 / 3;
  let done = null;

  const cal = new Calibrator({
    container,
    extendCorners: !!opts.extendCorners,
    getAspect: () => aspect,
    getLandmarks: ({ page }) => simLandmarksFor(page.x, page.y, aspect, { noise: 0.004, rnd }),
    onDone: (r) => {
      done = r;
    },
  });

  let now = 0;
  let guard = 0;
  cal.start();
  while (!done && guard < 20000) {
    now += 16;
    cal.update(now);
    guard += 1;
  }
  if (!done) throw new Error('标定未在预期帧数内结束');
  return done;
}

const a = runOnce(20261120);
const b = runOnce(20261120);
const c13 = runOnce(20261120, { extendCorners: true });

const failures = [];
if (a.samples.length !== 9) failures.push(`samples=${a.samples.length}（期望 9）`);
if (c13.samples.length !== 13) failures.push(`13 点模式 samples=${c13.samples.length}（期望 13）`);
if (!a.model || a.model.ok !== true) failures.push('model.ok 不为 true');
const avg = a.model && a.model.quality && a.model.quality.avgErr;
if (!(avg >= 0 && avg <= 0.1)) failures.push(`avgErr=${avg}（期望 0..0.1）`);
if (JSON.stringify(a.model) !== JSON.stringify(b.model)) failures.push('同种子两次模型 JSON 不一致');

if (failures.length) {
  console.error('FAIL calibrator');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('PASS calibrator');
console.log(`  samples=${a.samples.length} skipped=${a.skipped.length}`);
console.log(`  model.ok=${a.model.ok} variant=${a.model.variant}`);
console.log(`  avgErr=${a.model.quality.avgErr} maxErr=${a.model.quality.maxErr} grade=${a.model.quality.grade}`);
console.log('  deterministic: same seed → identical model JSON');
console.log(`  13 点扩展：samples=${c13.samples.length} ok=${c13.model && c13.model.ok}（默认关闭，仅测试台对照用）`);

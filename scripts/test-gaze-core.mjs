#!/usr/bin/env node
/**
 * 共享眼动核心的回归测试（Node，无需浏览器）。
 *
 * 用固定随机种子的合成标定样本跑一遍 fit，与 golden 快照逐位比较。
 * 搬迁时的一次性验证是「git HEAD 旧实现 vs 新核心」；本脚本负责之后每次改动的防漂移。
 *
 * 用法：
 *   node scripts/test-gaze-core.mjs
 * 退出码：0 通过，1 不一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.resolve(root, '..', '.deepworks', 'tmp', 'gaze-core-test');

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

// 把 ESM 源码复制成 .mjs 供 Node 直接 import（仓库文件本身保持 .js，给浏览器用）
const coreDir = path.join(root, 'shared', 'gaze', 'core');
for (const f of fs.readdirSync(coreDir)) {
  if (!f.endsWith('.js')) continue;
  const src = fs
    .readFileSync(path.join(coreDir, f), 'utf8')
    .replace(/from '\.\/([a-z-]+)\.js'/g, "from './$1.mjs'");
  fs.writeFileSync(path.join(tmp, f.replace(/\.js$/, '.mjs')), src);
}

const m = await import(pathToFileURL(path.join(tmp, 'index.mjs')).href);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const aspect = 4 / 3;
const cols = [0.1, 0.5, 0.9];
const rows = [0.12, 0.5, 0.88];
const rnd = mulberry32(20261119);

const samples = [];
for (const ty of rows) {
  for (const tx of cols) {
    const frames = [];
    for (let i = 0; i < 24; i += 1) {
      frames.push({ lm: m.simLandmarksFor(tx, ty, aspect, { noise: 0.0015, rnd }), tx, ty });
    }
    samples.push(m.medianSample(frames, aspect));
  }
}

const model = m.GazeCalibModel.fit(samples, { aspect, ridge: 0.01, created: 0, now: 0 });
const actual = {
  variant: model.variant,
  termsX: model.termsX,
  termsY: model.termsY,
  wx: model.wx,
  wy: model.wy,
  quality: model.quality,
};

const golden = {
  variant: 'reduced',
  termsX: ['dLx', 'dRx', 'eyeDist', 'roll'],
  termsY: ['dLy', 'dRy', 'eyeDist', 'roll'],
  wx: [0.5, -0.17478296230851123, -0.16940304434104272, -0.0016706873982757302, 0.004496672890873274],
  wy: [0.5, 0.15915315623625662, 0.16764063744153987, -0.008304766813377435, -0.007898515728846707],
  quality: {
    avgErr: 0.017447554166526817,
    maxErr: 0.03979745198341915,
    fitErr: 0.013232840287545485,
    cv: 9,
    grade: 'good',
  },
};

const a = JSON.stringify(actual);
const b = JSON.stringify(golden);

if (a === b) {
  console.log('PASS  gaze-core golden snapshot');
  console.log('      variant=' + model.variant + ' avgErr=' + model.quality.avgErr);
  process.exit(0);
}

console.log('FAIL  gaze-core 输出与 golden 不一致');
console.log('actual  :', a);
console.log('expected:', b);
process.exit(1);

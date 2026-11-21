/**
 * preview.fitPreview 单测：3 点起能解出「朝注视点移动」的线性映射。
 * 运行：node scripts/test-preview-fit.mjs
 */
import { fitPreview } from '../shared/gaze/calibrate/preview.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('FAIL ' + msg);
  }
};
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// 1) 合成数据：tx 由 dLx 决定，ty 由 dLy 决定
const truth = (dLx, dLy) => ({ tx: 0.5 + dLx * 3.0, ty: 0.5 + dLy * 4.0 });
const make = (dLx, dLy) => {
  const t = truth(dLx, dLy);
  return { f: { dLx, dLy }, tx: t.tx, ty: t.ty };
};
const three = [make(-0.1, -0.05), make(0, 0), make(0.1, 0.06)];
const m3 = fitPreview(three);
ok(!!m3, '3 点应能拟合');
ok(m3 && m3.n === 3, 'n = 3');
if (m3) {
  const p = m3.predict({ dLx: 0.05, dLy: -0.03 });
  const t = truth(0.05, -0.03);
  ok(near(p.x, t.tx), `x 预测 ${p.x.toFixed(3)} ≈ ${t.tx.toFixed(3)}`);
  ok(near(p.y, t.ty), `y 预测 ${p.y.toFixed(3)} ≈ ${t.ty.toFixed(3)}`);
}

// 2) 空样本返回 null；2 点即可解一条直线（水平/垂直各自回归）
ok(fitPreview([]) === null, '空样本 → null');
ok(fitPreview([{ f: { dLx: 0, dLy: 0 }, tx: 0.5, ty: 0.5 }]) === null, '1 点 → null');
const m2 = fitPreview([make(-0.08, -0.04), make(0.08, 0.04)]);
ok(!!m2, '2 点可拟合');
if (m2) ok(near(m2.predict({ dLx: 0, dLy: 0 }).x, 0.5), '2 点中点预测居中');

// 3) 输出必须 clamp 在 0..1
const wild = [make(-1, -1), make(0, 0), make(1, 1)];
const mw = fitPreview(wild);
if (mw) {
  const p = mw.predict({ dLx: 5, dLy: 5 });
  ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, 'clamp 到页面内');
}

// 4) 噪声样本不应崩、不应给 null
const noisy = [
  make(-0.12, 0.02), make(-0.02, -0.04), make(0.06, 0.01), make(0.13, -0.02), make(0.0, 0.05),
].map((s) => ({ f: { dLx: s.f.dLx + 0.004, dLy: s.f.dLy - 0.003 }, tx: s.tx, ty: s.ty }));
const mn = fitPreview(noisy);
ok(!!mn && mn.n === 5, '5 点噪声样本可拟合');
if (mn) {
  const p = mn.predict({ dLx: 0.1, dLy: 0 });
  ok(p.x > 0.6, `右上方向 x=$ {p.x.toFixed(3)} 应偏右`);
}

// 5) 缺字段样本被跳过
const mixed = [make(0, 0), { f: {}, tx: 0.5, ty: 0.5 }, make(0.1, 0.1), { f: { dLx: 0.2 }, tx: 0.7, ty: 0.3 }, make(0.05, -0.05)];
const mm = fitPreview(mixed);
ok(!!mm && mm.n === 3, '只统计字段完整的样本');

console.log(`${fail === 0 ? 'PASS' : 'FAIL'} preview-fit  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

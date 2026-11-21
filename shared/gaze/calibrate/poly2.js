/**
 * @file 二阶多项式特征 + 等权岭回归（alpha 固定 1.0）。
 *
 * 口径来自统一标定协议：
 *   - 特征先按样本做 z-score 标准化
 *   - 展开为「线性项 + 平方项 + 两两交叉项」
 *   - 所有样本 weight = 1（无衰减、无点击加权）
 *   - 截距项不做正则化
 *   - screenX / screenY 各自训练一组系数
 *
 * 纯函数，无 DOM 依赖，可在 Node 里直接测。
 */

import { FEATURE_KEYS, RIDGE_ALPHA } from './protocol.js';

/**
 * 生成二阶展开项。每项是特征名数组（长度 1 或 2），按固定顺序输出。
 * @param {readonly string[]} keys
 * @returns {string[][]}
 */
export function buildTerms(keys = FEATURE_KEYS) {
  const terms = [];
  for (let i = 0; i < keys.length; i += 1) terms.push([keys[i]]);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i; j < keys.length; j += 1) terms.push([keys[i], keys[j]]);
  }
  return terms;
}

/** 均值 */
function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : 0;
}

/** 总体标准差（分母 n） */
function stddev(xs, m) {
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return xs.length ? Math.sqrt(s / xs.length) : 0;
}

/**
 * 高斯消元（列主元），原地求解 A x = b。
 * @param {number[][]} A
 * @param {number[]} b
 * @returns {number[]|null}
 */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const t = M[piv];
      M[piv] = M[col];
      M[col] = t;
    }
    const diag = M[col][col];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / diag;
      if (!f) continue;
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(M[i][i]) < 1e-12) return null;
    out[i] = M[i][n] / M[i][i];
  }
  return out;
}

/**
 * 拟合一个轴的岭回归。
 * @param {number[][]} Z 标准化后的样本特征表
 * @param {number[]} y 目标值
 * @param {string[][]} terms 二阶展开项
 * @param {number} alpha
 * @returns {number[]|null} 系数（第 0 位是截距）
 */
export function ridge(Z, y, terms, alpha = RIDGE_ALPHA) {
  const m = terms.length + 1;
  const N = Array.from({ length: m }, () => new Array(m).fill(0));
  const g = new Array(m).fill(0);
  for (let r = 0; r < Z.length; r += 1) {
    const row = [1];
    for (const t of terms) {
      let v = 1;
      for (const k of t) v *= Z[r][k];
      row.push(v);
    }
    for (let i = 0; i < m; i += 1) {
      g[i] += row[i] * y[r];
      for (let j = 0; j < m; j += 1) N[i][j] += row[i] * row[j];
    }
  }
  // 截距不惩罚；其余对角加 alpha（等权岭回归）
  for (let i = 1; i < m; i += 1) N[i][i] += alpha;
  return solve(N, g);
}

/**
 * 训练二阶模型。
 *
 * @param {Array<{f: object, tx: number, ty: number}>} samples
 * @param {object} [opts]
 * @param {readonly string[]} [opts.keys]
 * @param {number} [opts.alpha]
 * @returns {{
 *   ok: boolean, reason?: string, version: number, keys: string[], terms: string[][],
 *   mean: object, std: object, wx: number[], wy: number[], alpha: number, n: number,
 *   fit: { points: Array<{tx:number,ty:number,px:number,py:number,err:number}>, avg: number }
 * } | null}
 */
export function fitPoly2(samples, opts = {}) {
  const keys = Array.isArray(opts.keys) && opts.keys.length ? opts.keys : FEATURE_KEYS;
  const alpha = Number.isFinite(opts.alpha) ? opts.alpha : RIDGE_ALPHA;
  const aspect = Number.isFinite(opts.aspect) && opts.aspect > 0.1 ? opts.aspect : 4 / 3;
  const pts = (samples || []).filter(
    (s) =>
      s &&
      s.f &&
      Number.isFinite(s.tx) &&
      Number.isFinite(s.ty) &&
      keys.every((k) => Number.isFinite(s.f[k])),
  );
  if (pts.length < keys.length + 1) return null;

  const meanMap = {};
  const stdMap = {};
  for (const k of keys) {
    const col = pts.map((p) => p.f[k]);
    const m = mean(col);
    meanMap[k] = m;
    // 下限只防除零；标定阵型本身会让眼球特征有真实方差
    stdMap[k] = Math.max(1e-4, stddev(col, m));
  }

  const Z = pts.map((p) => {
    const z = {};
    for (const k of keys) z[k] = (p.f[k] - meanMap[k]) / stdMap[k];
    return z;
  });
  const terms = buildTerms(keys);
  const wx = ridge(Z, pts.map((p) => p.tx), terms, alpha);
  const wy = ridge(Z, pts.map((p) => p.ty), terms, alpha);
  if (!wx || !wy) return null;

  const model = {
    ok: true,
    version: 2,
    keys: keys.slice(),
    terms,
    mean: meanMap,
    std: stdMap,
    wx,
    wy,
    alpha,
    aspect,
    n: pts.length,
    fit: { points: [], avg: 0 },
  };

  let sum = 0;
  for (const p of pts) {
    const q = predictPoly2(model, p.f);
    const err = q ? Math.hypot(q.x - p.tx, q.y - p.ty) : NaN;
    if (Number.isFinite(err)) sum += err;
    model.fit.points.push({ tx: p.tx, ty: p.ty, px: q ? q.x : NaN, py: q ? q.y : NaN, err });
  }
  model.fit.avg = pts.length ? sum / pts.length : NaN;
  return model;
}

/**
 * 预测。输入原始特征对象，输出 PAGE_NORM。
 * @param {object} model
 * @param {object} f
 * @returns {{x:number,y:number}|null}
 */
export function predictPoly2(model, f) {
  if (!model || !model.ok || !f) return null;
  for (const k of model.keys) {
    if (!Number.isFinite(f[k])) return null;
  }
  const evalAxis = (w) => {
    let s = w[0];
    for (let i = 0; i < model.terms.length; i += 1) {
      let v = 1;
      for (const k of model.terms[i]) {
        v *= (f[k] - model.mean[k]) / model.std[k];
      }
      s += w[i + 1] * v;
    }
    return s;
  };
  return { x: evalAxis(model.wx), y: evalAxis(model.wy) };
}

/**
 * 单帧误差（PAGE_NORM 欧氏距离）。
 * @param {object} model
 * @param {object} f
 * @param {{x:number,y:number}} target
 * @returns {number} 无预测时返回 NaN
 */
export function pointError(model, f, target) {
  const q = predictPoly2(model, f);
  if (!q || !target) return NaN;
  const tx = Number.isFinite(target.tx) ? target.tx : target.x;
  const ty = Number.isFinite(target.ty) ? target.ty : target.y;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return NaN;
  return Math.hypot(q.x - tx, q.y - ty);
}

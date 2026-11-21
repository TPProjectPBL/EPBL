/**
 * @file 岭回归求解、留一评分与敏感度探针。
 *
 * 从 `gaze-calib.js` 原样迁移，包含 2026-10-20 真机事故相关的全部注释。
 */
import {
  FEATURES,
  MIN_STD,
  POSE_SHRINK,
  POSE_TERMS,
  SENS_PROBE,
  TERM_SETS,
  avg,
  corr,
  stddev,
  wmean,
  wstd,
} from './features.js';
import { GazeCalibModel } from './model.js';

export function gaussSolve(N, b) {
  const n = b.length;
  const A = N.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const t = A[piv];
      A[piv] = A[col];
      A[col] = t;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  // 消元后已是单位对角，直接回代
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.abs(A[i][i]) < 1e-12) return null;
    out[i] = A[i][n] / A[i][i];
  }
  return out;
}

/**
 * 岭回归：zs 为标准化后的特征表，terms 为使用的特征名，b 为目标值列。
 * weights 为可选样本权重（加权最小二乘）；null 时逐位等同旧实现。
 */
export function ridgeSolve(zs, b, terms, ridge, weights = null) {
  const m = terms.length + 1;
  const N = Array.from({ length: m }, () => new Array(m).fill(0));
  const g = new Array(m).fill(0);
  for (let r = 0; r < zs.length; r++) {
    const w = weights ? weights[r] : 1;
    if (!(w > 0)) continue;
    const row = [1];
    for (const k of terms) row.push(zs[r][k]);
    for (let i = 0; i < m; i++) {
      g[i] += w * row[i] * b[r];
      for (let j = 0; j < m; j++) N[i][j] += w * row[i] * row[j];
    }
  }
  for (let i = 1; i < m; i++) N[i][i] += ridge; // 截距项不正则化
  return gaussSolve(N, g);
}

/** 核心拟合：标准化 + 两轴岭回归。返回 {mean,std,wx,wy} 或 null */
export function fitCore(pts, ridge, aspect = 4 / 3, set = TERM_SETS.full, weights = null) {
  const mean = {};
  const std = {};
  const rawStd = {};
  for (const k of FEATURES) {
    const col = pts.map((p) => p.f[k]);
    // 有权重时均值/标准差也按权重算（否则标准化与回归的样本空间不一致）。
    // 无权重时保留 avg/stddev 原路径，保证旧数值与真机回归断言不受影响。
    mean[k] = weights ? wmean(col, weights) : avg(col);
    rawStd[k] = weights ? wstd(col, mean[k], weights) : stddev(col, mean[k]);
    // 夹分母只为数值稳定；**真实**跨点方差单独留在 rawStd 里给退化门判断用
    std[k] = Math.max(MIN_STD[k] || 1e-3, rawStd[k]);
  }
  // 姿势项额外收缩（见 POSE_SHRINK 注释）：只动分母，rawStd 保持原值
  for (const k of POSE_TERMS) if (std[k] != null) std[k] *= POSE_SHRINK;
  const zs = pts.map((p) => {
    const z = {};
    for (const k of FEATURES) z[k] = (p.f[k] - mean[k]) / std[k];
    return z;
  });
  const wx = ridgeSolve(zs, pts.map((p) => p.tx), set.x, ridge, weights);
  const wy = ridgeSolve(zs, pts.map((p) => p.ty), set.y, ridge, weights);
  if (!wx || !wy) return null;
  const a = isFinite(aspect) && aspect > 0.1 ? aspect : 4 / 3;
  const txs = pts.map((p) => p.tx);
  const tys = pts.map((p) => p.ty);
  const stats = {
    n: pts.length,
    rawStd,
    eyeStdX: Math.max(rawStd.dLx, rawStd.dRx),
    eyeStdY: Math.max(rawStd.dLy, rawStd.dRy),
    headMove: Math.max(rawStd.faceCx, rawStd.faceCy / a),
    eyeDistStd: rawStd.eyeDist,
    rollStd: rawStd.roll,
    corrX: Math.max(Math.abs(corr(pts.map((p) => p.f.dLx), txs)), Math.abs(corr(pts.map((p) => p.f.dRx), txs))),
    corrY: Math.max(Math.abs(corr(pts.map((p) => p.f.dLy), tys)), Math.abs(corr(pts.map((p) => p.f.dRy), tys))),
  };
  return { mean, std, rawStd, wx, wy, stats };
}

/** w0 + Σ wi·(f[term] - mean)/std */
export function dotStd(w, terms, f, mean, std) {
  let s = w[0];
  for (let i = 0; i < terms.length; i++) {
    const k = terms[i];
    s += w[i + 1] * ((f[k] - mean[k]) / std[k]);
  }
  return s;
}

/**
 * 敏感度：演示时「几乎察觉不到的小动作」会让光标动多少（屏幕宽/高比例）。
 * 线性模型下与当前注视位置无关，只取决于权重与分母，所以直接算斜率即可。
 * 这是 2026-10-20 真机暴露的问题：留一误差只覆盖「同一坐姿内的新注视点」，
 * 完全不反映「换个姿势」的表现——实测某个模型脸前后动 0.1% 光标就跳 12.5% 屏高。
 * @returns {{head:number, dist:number, tilt:number}}
 */
export function sensitivityOf(core, set) {
  const step = (deltas) => {
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < set.x.length; i++) {
      const k = set.x[i];
      if (deltas[k]) dx += (core.wx[i + 1] * deltas[k]) / core.std[k];
    }
    for (let i = 0; i < set.y.length; i++) {
      const k = set.y[i];
      if (deltas[k]) dy += (core.wy[i + 1] * deltas[k]) / core.std[k];
    }
    return Math.hypot(dx, dy);
  };
  return {
    head: step({ faceCx: SENS_PROBE.head, faceCy: SENS_PROBE.head }),
    dist: step({ eyeDist: SENS_PROBE.dist }),
    tilt: step({ roll: SENS_PROBE.tilt }),
  };
}

/**
 * 给「一套特征集 + 一个岭系数」打分：内部用留一交叉验证算**诚实的泛化误差**。
 * 样本内残差必然乐观（9 点拟 6 参数时大约只有留一的一半），只用于画误差图；
 * 对外口径、退化门、特征集择优一律用留一数字。
 * @returns {{core:object, points:Array, fitErr:number, avgErr:number, maxErr:number,
 *            looErr:number[], cv:number, worstAt:number[]|null, terms:number}|null}
 */
export function looScore(pts, ridge, aspect, set, weights = null) {
  const core = fitCore(pts, ridge, aspect, set, weights);
  if (!core) return null;
  const mk = (c, n) => new GazeCalibModel({
    ok: true, aspect, n, termsX: set.x, termsY: set.y, ...c,
  });
  const full = mk(core, pts.length);

  // 样本内：模型在标定点上的预测落点（误差图用它，方便用户看出"形状"问题）
  let fitSum = 0;
  const points = pts.map((p) => {
    const q = full.predict(p.f);
    if (!q) return { tx: p.tx, ty: p.ty, px: p.tx, py: p.ty, err: NaN };
    const err = Math.hypot(q.x - p.tx, q.y - p.ty);
    fitSum += err;
    return { tx: p.tx, ty: p.ty, px: q.x, py: q.y, err };
  });

  // 留一：每次留一个点不参与拟合，用它预测那个点
  let sum = 0;
  let max = 0;
  let counted = 0;
  const looErr = new Array(pts.length).fill(NaN);
  for (let i = 0; i < pts.length; i++) {
    const keep = pts.filter((_, j) => j !== i);
    const wSub = weights ? weights.filter((_, j) => j !== i) : null;
    const c = fitCore(keep, ridge, aspect, set, wSub);
    if (!c) continue;
    const q = mk(c, pts.length - 1).predict(pts[i].f);
    if (!q) continue;
    const err = Math.hypot(q.x - pts[i].tx, q.y - pts[i].ty);
    looErr[i] = err;
    sum += err;
    counted += 1;
    if (err > max) max = err;
  }
  const avgErr = counted ? sum / counted : fitSum / pts.length;

  // 最差的点在屏幕哪一块：告诉用户"哪片区域的小按钮先别指望"
  let worstAt = null;
  let worstErr = -1;
  for (let i = 0; i < pts.length; i++) {
    if (isFinite(looErr[i]) && looErr[i] > worstErr) {
      worstErr = looErr[i];
      worstAt = [pts[i].tx, pts[i].ty];
    }
  }
  return {
    core, points, fitErr: fitSum / pts.length, avgErr, maxErr: max, looErr, cv: counted, worstAt,
    terms: set.x.length + set.y.length,
    sens: sensitivityOf(core, set),
  };
}

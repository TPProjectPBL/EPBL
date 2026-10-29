/**
 * 绝对注视点估计 · demo 级实现（9 点个人标定 + 岭回归）
 *
 * 背景：设计报告阶段 3「眼神方向估计」尚未交付，air-draw 里的 GazeCursorSource 是
 * 「虹膜相对偏移 × 增益」的代理实现 —— 只能表达相对方向，头一动就整体漂移，也没有
 * 个体差异（天生眼球朝角）补偿。本文件把代理升级成「个人标定后的绝对屏幕坐标」：
 *
 *   标定：屏幕 9 个点依次亮起 → 每个点先等 0.35s 让眼球到位、再采 1.2s（约 24~30 帧）
 *   特征：两眼虹膜相对眼眶中心（眼角中点）的位移，按眼宽归一 → dLx/dLy/dRx/dRy
 *         另附头部滚转 roll、双眼间距 eyeDist 做旋转/远近的一阶补偿
 *   回归：横向 [dLx, dRx, eyeDist, roll]、纵向 [dLy, dRy, eyeDist, roll]，各 4 特征 + 截距
 *         （5 参数 / 9 个标定点）。先 z-score 标准化再解岭回归正规方程。
 *   质量：留一交叉验证平均误差 → 评级；同时做退化门（眼球信号太弱 / 误差超上限 → 明确失败）
 *
 * 为什么**不**用头部位移（faceCx/faceCy）做特征：头平移会让虹膜与眼眶中心一起动，
 * 「(虹膜 − 眼眶中心) / 眼宽」本身已对平移免疫；多加头动项只会在用户「转头看四角」时
 * 让它主导拟合，把头动当注视信号 —— 2026-10-20 真人实测因此得到 50.4% 的废模型。
 *
 * 精度边界（诚实说明）：普通摄像头没有红外，虹膜关键点抖动约 1~2px；合成数据下坐姿固定、
 * 标定良好时留一误差约 ±4%（中心区），四角更差；**头一动就会漂**（roll/eyeDist 只做一阶补偿）。
 * 要做产品级精度必须换硬件或等阶段 3 交付。真人实测取决于关键点质量，必须先看诊断结论再用。
 *
 * 坐标系约定：
 *   - 特征是「图像帧原始坐标」（x 归一化到画面宽、y 归一化到画面高，未镜像）
 *   - 预测值 tx/ty 是「页面归一化坐标」（标定点的实际屏幕位置）
 */

import { GazeCursorSource } from '../../air-draw/lib/gaze-source.js';

/* ---------------------------------------------------------------- 常量 */

export const FEATURES = ['dLx', 'dLy', 'dRx', 'dRy', 'faceCx', 'faceCy', 'eyeDist', 'roll'];

/**
 * 两套候选特征集，标定时**按留一误差自动择优**。
 *
 * - `full` 含头部位移（faceCx/faceCy）：只有当标定过程本身覆盖了头动（多姿势标定）时，
 *   回归才能辨识出「头动补偿」系数；这种标定在用户换坐姿后更稳（实测测试项：
 *   头右移 0.1 → 预测自动左移 ≈0.08）。
 * - `reduced` 不含头动项：适合「头基本不动、只看眼睛」的标定。头平移会让虹膜和眼眶中心
 *   一起动，而 (虹膜 − 眼眶中心)/眼宽 本身对平移免疫，所以在头动无规律时，
 *   含头动项的模型会让头动主导拟合、把噪声当信号（2026-10-20 真人实测 50.4% 事故的嫌疑之一）。
 *
 * 两套都用留一交叉验证打分，取误差小的那套；诊断数据里会同时记录两者的分数，
 * 一眼就能看出「这次是不是头动在捣乱」。
 */
export const TERM_SETS = {
  full: {
    x: ['dLx', 'dRx', 'faceCx', 'eyeDist', 'roll'],
    y: ['dLy', 'dRy', 'faceCy', 'eyeDist', 'roll'],
  },
  reduced: {
    x: ['dLx', 'dRx', 'eyeDist', 'roll'],
    y: ['dLy', 'dRy', 'eyeDist', 'roll'],
  },
};

/** 默认（旧数据向后兼容）特征项 = full 集 */
export const X_TERMS = TERM_SETS.full.x;
export const Y_TERMS = TERM_SETS.full.y;

/**
 * 岭系数候选网格，按留一误差自动挑最好的那个。
 * 依据 2026-10-20 真机 9 点数据扫描：λ=0.01（原固定值）→ 平均 5.20% / 最大 13.01%；
 * λ=0.10 → 平均 4.60% / 最大 9.77%。λ 太小会让"没什么变化的特征"（如标定时头没动
 * 时的 faceCx，跨点 std 只有 0.0014）被 z-score 放大成噪声权重；λ 太大则整体欠拟合。
 * U 形最低点就在 0.1 附近，所以让数据自己选，而不是钉死一个值。
 */
export const LAMBDA_GRID = [0.003, 0.01, 0.03, 0.1, 0.3];

/** 少于这个样本数不拟合（full 集 5 特征 + 截距 = 6 参数，9 点留 3 个自由度） */
export const MIN_SAMPLES = 8;

/** 评级阈值（平均误差，单位为归一化屏宽比例） */
export const GRADE_LIMITS = { good: 0.05, ok: 0.09 };

/**
 * 退化门槛：眼球位移的**真实**（未夹取）跨点标准差低于此值时不拟合。
 * 这一条是 50.4% 事故的直接补丁：原来 MIN_STD 只用来夹分母，特征几乎不变时
 * z-score 会把纯噪声放大成权重，拟合出一个「预测点撒满全屏」的废模型却标成 ok。
 */
export const MIN_EYE_STD = { x: 0.012, y: 0.008 };

/** 头部移动（按画面宽归一的跨点标准差）超过此值提示「头动偏大」 */
export const HEAD_MOVE_WARN = 0.05;

/** 平均留一误差超过此值直接判不可用（1/4 屏宽已经点不到任何东西） */
export const MAX_ACCEPT_ERR = 0.25;

/**
 * 在线学习（点击即训练）的样本权重参数。
 *
 * 背景（借鉴 WebGazer 的 weightedRidge）：WebGazer 把用户的每次点击都当成一条训练样本，
 * 并让**新样本权重更高**。我们的场景更受益于这一点：真机实测「换一次会话脸距漂移 0.0217，
 * 是会话内信号（0.001 量级）的 20 倍」，也就是说坐姿每隔几十分钟就会缓慢漂移一次，
 * 越老的样本越不代表当前姿势。
 *
 * 三条经验值：
 *   - 基础权重 0.6：点击样本的标签是「按钮中心」而不是精确的注视点（用户可能在看按钮边缘），
 *     可信度低于标定点，所以不到 1。
 *   - 半衰期 90s：约等于"坐姿明显漂移"的时间尺度，同时也限制单次会话内的样本影响。
 *   - 权重下限 0.15：不让老样本彻底消失（否则只剩少数新样本，方差会爆炸），
 *     超出容量时由 trainer 按权重淘汰。
 */
export const CLICK_WEIGHT = 0.6;
export const CLICK_HALF_LIFE_MS = 90000;
export const CLICK_WEIGHT_FLOOR = 0.15;


/** 特征标准差下限：防止「某项特征几乎不变」时 z-score 爆炸 */
const MIN_STD = {
  dLx: 0.01,
  dLy: 0.01,
  dRx: 0.01,
  dRy: 0.01,
  faceCx: 0.02,
  faceCy: 0.02,
  eyeDist: 0.01,
  roll: 0.02,
};

/**
 * 姿势项：头动/脸距/歪头。它们在标定数据里常常几乎不变（真机 rawStd 只有 0.001 量级），
 * z-score 会把这点噪声放大成很大的权重——实测「脸前后动 0.1% 光标就跳 12.5% 屏高」。
 * 对这些项额外收缩：把 std 乘 k，等价于把该项的岭系数乘 k²（z 缩小 k 倍 → 达到同样效果需要 k 倍大的权 → 惩罚 k² 倍）。
 * 这样眼球信号的正则强度不受影响，姿势项被单独压住。
 */
export const POSE_TERMS = ['faceCx', 'faceCy', 'eyeDist', 'roll'];
export const POSE_SHRINK = 3; // 等效姿势项 λ 是眼球项的 POSE_SHRINK² ≈ 9 倍

/** 演示时「几乎察觉不到的小动作」允许让光标动多少（屏幕宽/高比例） */
export const SENS_LIMIT = 0.03;
/** 敏感度探针的动作幅度：头平移 0.5% 画面宽 / 脸前后 0.1% / 歪头约 0.6° */
export const SENS_PROBE = { head: 0.005, dist: 0.001, tilt: 0.01 };

/** Face Mesh 索引（refineLandmarks=true 时 468 为左虹膜中心、473 为右虹膜中心） */
const IDX = {
  leftIris: 468,
  rightIris: 473,
  leftOuter: 33,
  leftInner: 133,
  leftTop: 159,
  leftBottom: 145,
  rightOuter: 263,
  rightInner: 362,
  rightTop: 386,
  rightBottom: 374,
};

const NEED_IDX = Object.values(IDX);

/* ---------------------------------------------------------------- 小工具 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 样本权重：标定点 = 1；点击样本 = 基础权重 × 0.5^(年龄/半衰期)，带下限。
 * 没有任何点击样本时返回 null —— 调用方据此走**无权重**路径，数值结果与旧版逐位一致
 * （真机回归断言不受在线学习功能影响，出问题时可以先关掉在线学习再复现）。
 */
export function sampleWeights(pts, now = 0, halfLifeMs = CLICK_HALF_LIFE_MS) {
  let decayed = false;
  const hl = isFinite(halfLifeMs) && halfLifeMs > 0 ? halfLifeMs : CLICK_HALF_LIFE_MS;
  const w = (pts || []).map((p) => {
    if (!p || p.kind !== 'click') return 1;
    decayed = true;
    const age = Math.max(0, (isFinite(now) ? now : 0) - (isFinite(p.t) ? p.t : 0));
    return Math.max(CLICK_WEIGHT_FLOOR, CLICK_WEIGHT * Math.pow(0.5, age / hl));
  });
  return decayed ? w : null;
}

/** 加权均值 */
function wmean(list, w) {
  let s = 0;
  let sw = 0;
  for (let i = 0; i < list.length; i++) {
    const wi = w[i] > 0 ? w[i] : 0;
    s += wi * list[i];
    sw += wi;
  }
  return sw > 0 ? s / sw : 0;
}

/** 加权标准差（有偏分母 Σw；与无权重的无偏 stddev 不同，但只在有权重时使用） */
function wstd(list, mean, w) {
  let s = 0;
  let sw = 0;
  for (let i = 0; i < list.length; i++) {
    const wi = w[i] > 0 ? w[i] : 0;
    s += wi * (list[i] - mean) * (list[i] - mean);
    sw += wi;
  }
  return sw > 1e-9 ? Math.sqrt(s / sw) : 0;
}

function avg(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const v of list) s += v;
  return s / list.length;
}

function stddev(list, mean) {
  if (list.length < 2) return 0;
  let s = 0;
  for (const v of list) s += (v - mean) * (v - mean);
  return Math.sqrt(s / (list.length - 1));
}

function median(list) {
  if (!list.length) return 0;
  const a = list.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 皮尔逊相关系数；任一侧没有方差（或样本太少）时返回 0 */
function corr(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = avg(xs.slice(0, n));
  const my = avg(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  if (sxx <= 1e-12 || syy <= 1e-12) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** 高斯消元（列主元）；奇异返回 null */
function gaussSolve(N, b) {
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
function ridgeSolve(zs, b, terms, ridge, weights = null) {
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
function fitCore(pts, ridge, aspect = 4 / 3, set = TERM_SETS.full, weights = null) {
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
function dotStd(w, terms, f, mean, std) {
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
function looScore(pts, ridge, aspect, set, weights = null) {
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

/* ---------------------------------------------------------------- 特征提取 */

/** 把 y 方向换算到「以宽为单位」的同一尺度（aspect = 画面宽/高） */
const y2x = (v, aspect) => v / aspect;

/**
 * 从 Face Mesh 关键点提特征。缺虹膜点或关键点非法时返回 null。
 *
 * 特征设计说明（踩过的坑）：最初沿用 GazeCursorSource 的「虹膜在眼眶 bbox 内的比值」，
 * 但垂直方向眼眶只有约 0.02 归一化高度，关键点抖动 ±0.004 时比值 = 噪/噪，
 * 逐帧比值的中位数会系统性偏向 0.5（比值估计的偏差），标定数据被压缩、预测就偏。
 * 改成「按眼宽归一的位移」后，分母（眼宽 ~0.052）比眼眶高度大得多、噪声相对更小，
 * 两轴尺度统一，剩余非线性交给线性回归自己学（回归只看单调关系，不关心特征量纲）。
 *
 * @param {Array} lm 478 点（refineLandmarks=true）
 * @param {number} aspect 画面宽高比
 */
export function extractFeatures(lm, aspect = 4 / 3) {
  if (!lm || lm.length < 478) return null;
  for (const i of NEED_IDX) {
    const p = lm[i];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return null;
  }
  const a = isFinite(aspect) && aspect > 0.1 ? aspect : 4 / 3;
  const dx = lm[IDX.rightOuter].x - lm[IDX.leftOuter].x;
  const dy = lm[IDX.rightOuter].y - lm[IDX.leftOuter].y;

  // 左眼：中心 + 真实眼宽（滚转不变的长度，y 已换算到 x 尺度）
  const lW = Math.hypot(
    lm[IDX.leftInner].x - lm[IDX.leftOuter].x,
    y2x(lm[IDX.leftInner].y - lm[IDX.leftOuter].y, a),
  );
  const lcx = (lm[IDX.leftOuter].x + lm[IDX.leftInner].x) / 2;
  // 垂直中心用**内外眼角的 y 中点**，不用上下眼睑中点：睑裂会随眨眼/眯眼上下移动，
  // 会把眨眼和「眼球转动伴随的眼皮跟随」混进 dLy；眼角是更稳的参考。
  const lcy = (lm[IDX.leftOuter].y + lm[IDX.leftInner].y) / 2;
  const lw = Math.max(1e-6, lW);
  // 右眼
  const rW = Math.hypot(
    lm[IDX.rightInner].x - lm[IDX.rightOuter].x,
    y2x(lm[IDX.rightInner].y - lm[IDX.rightOuter].y, a),
  );
  const rcx = (lm[IDX.rightOuter].x + lm[IDX.rightInner].x) / 2;
  const rcy = (lm[IDX.rightOuter].y + lm[IDX.rightInner].y) / 2;
  const rw = Math.max(1e-6, rW);

  return {
    dLx: (lm[IDX.leftIris].x - lcx) / lw,
    dLy: y2x(lm[IDX.leftIris].y - lcy, a) / lw,
    dRx: (lm[IDX.rightIris].x - rcx) / rw,
    dRy: y2x(lm[IDX.rightIris].y - rcy, a) / rw,
    faceCx: (lm[IDX.leftOuter].x + lm[IDX.rightOuter].x) / 2,
    faceCy: (lm[IDX.leftOuter].y + lm[IDX.rightOuter].y) / 2,
    eyeDist: Math.hypot(dx, y2x(dy, a)),
    roll: Math.atan2(dy, dx),
  };
}

/** 眼睛张开度（近似 EAR）：用于过滤眨眼/眯眼帧 */
export function eyeOpenness(lm) {
  if (!lm || lm.length < 478) return 0;
  const eye = (top, bottom, inner, outer) => {
    const v = Math.hypot(lm[top].x - lm[bottom].x, lm[top].y - lm[bottom].y);
    const h = Math.hypot(lm[inner].x - lm[outer].x, lm[inner].y - lm[outer].y) || 1e-6;
    return v / h;
  };
  return (
    (eye(IDX.leftTop, IDX.leftBottom, IDX.leftInner, IDX.leftOuter) +
      eye(IDX.rightTop, IDX.rightBottom, IDX.rightInner, IDX.rightOuter)) /
    2
  );
}

/** 这一帧能不能用来标定（有虹膜点、睁眼、关键点合法） */
export function isFaceUsable(lm, minOpenness = 0.16) {
  if (!extractFeatures(lm)) return false;
  return eyeOpenness(lm) >= minOpenness;
}

/**
 * 对同一标定点采集的多帧关键点做「逐坐标取中位数」，拼成一副干净的关键点。
 *
 * 注意顺序：必须**先中位数、后算特征**。若逐帧先算特征再对特征取中位数，
 * 比值类特征（噪声/噪声）的中位数会系统性偏移，标定数据被压缩，预测必然偏。
 */
export function medianLandmarks(frames) {
  const list = (frames || []).filter((fr) => fr && fr.lm);
  if (!list.length) return null;
  const lm = new Array(478).fill(null);
  for (const i of NEED_IDX) {
    const xs = [];
    const ys = [];
    for (const fr of list) {
      const p = fr.lm && fr.lm[i];
      if (p && isFinite(p.x) && isFinite(p.y)) {
        xs.push(p.x);
        ys.push(p.y);
      }
    }
    if (!xs.length) return null;
    lm[i] = { x: median(xs), y: median(ys) };
  }
  return lm;
}

/**
 * 把一个标定点的多帧样本压成一条训练样本。
 * @param {Array<{lm:Array}>} frames 同一标定点连续采集的帧
 * @param {number} aspect 画面宽高比
 * @returns {{f:object, tx:number, ty:number, n:number}|null}
 */
export function medianSample(frames, aspect = 4 / 3) {
  const list = (frames || []).filter((fr) => fr && fr.lm && isFinite(fr.tx) && isFinite(fr.ty));
  if (!list.length) return null;
  const a = isFinite(aspect) && aspect > 0.1 ? aspect : 4 / 3;

  // 先逐帧算特征，仅用于离群判定与统计（不参与建模）
  const feats = [];
  for (const fr of list) {
    const f = extractFeatures(fr.lm, a);
    if (f) feats.push({ fr, f });
  }
  if (!feats.length) return null;

  // MAD 离群剔除：眨眼残留、人脸检测跳变、眼镜反光都会让个别帧的关键点整体跑偏，
  // 一幅坏关键点就能把「逐坐标中位数」带歪。保留至少一半以免误杀。
  const droppedList = dropOutliers(feats);
  const kept = droppedList.length >= Math.max(3, Math.ceil(feats.length * 0.5)) ? droppedList : feats;

  const lm = medianLandmarks(kept.map((x) => x.fr));
  if (!lm) return null;
  const f = extractFeatures(lm, a);
  if (!f) return null;

  const eyeKeys = ['dLx', 'dLy', 'dRx', 'dRy'];
  const cols = {};
  for (const k of FEATURES) cols[k] = kept.map((x) => x.f[k]);
  const jitter = median(eyeKeys.map((k) => stddev(cols[k], avg(cols[k]))));
  const headRange = Math.max(range(cols.faceCx), range(cols.faceCy) / a);
  const openness = median(list.map((fr) => eyeOpenness(fr.lm)));
  const usable = list.filter((fr) => isFaceUsable(fr.lm)).length;

  return {
    f,
    tx: list[0].tx,
    ty: list[0].ty,
    n: list.length,
    usable,
    stats: {
      n: list.length,
      kept: kept.length,
      dropped: feats.length - kept.length,
      jitter,
      headRange,
      openness,
    },
  };
}

/** 极差（max − min） */
function range(list) {
  if (!list.length) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of list) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

/**
 * 稳健离群帧剔除：算每帧 8 维特征到中位数的「归一化距离」（每维除以 1.4826×MAD），
 * 超过中位数 + 3.5×MAD（下限 2.5）的帧丢掉。MAD 为 0 的维度直接跳过，避免除零。
 */
function dropOutliers(feats) {
  if (feats.length < 6) return feats;
  const med = {};
  const mad = {};
  for (const k of FEATURES) {
    const col = feats.map((x) => x.f[k]);
    med[k] = median(col);
    mad[k] = 1.4826 * median(col.map((v) => Math.abs(v - med[k])));
  }
  const dist = feats.map((x) => {
    let s = 0;
    let d = 0;
    for (const k of FEATURES) {
      if (!(mad[k] > 1e-9)) continue;
      const z = (x.f[k] - med[k]) / mad[k];
      s += z * z;
      d += 1;
    }
    return d ? Math.sqrt(s / d) : 0;
  });
  const dm = median(dist);
  const dmad = 1.4826 * median(dist.map((v) => Math.abs(v - dm)));
  const thr = Math.max(2.5, dm + 3.5 * dmad);
  return feats.filter((_, i) => dist[i] <= thr);
}

/* ---------------------------------------------------------------- 模型 */

export class GazeCalibModel {
  constructor(data = {}) {
    this.ok = !!data.ok;
    this.reason = data.reason || '';
    /** 用了哪套特征集：'full'（含头动项）或 'reduced' */
    this.variant = data.variant || 'full';
    this.termsX = Array.isArray(data.termsX) && data.termsX.length ? data.termsX : X_TERMS;
    this.termsY = Array.isArray(data.termsY) && data.termsY.length ? data.termsY : Y_TERMS;
    this.aspect = data.aspect || 4 / 3;
    this.created = data.created || 0;
    this.n = data.n || 0;
    this.mean = data.mean || null;
    this.std = data.std || null;
    this.wx = data.wx || null;
    this.wy = data.wy || null;
    this.quality = data.quality || null;
    /** 标定点的实测/预测对照，用于画误差图 */
    this.points = data.points || [];
    /** 诊断数据：眼球信号强度、头部移动、帧内抖动、相关性等（用于给用户可读建议） */
    this.diag = data.diag || null;
    /** 失败时可能同时命中多条（如「信号弱」+「头动大」） */
    this.reasons = data.reasons || null;
  }

  /**
   * 拟合。
   *
   * 质量分用**留一交叉验证**（每次拿 8 个点拟合、预测剩下的那点）而不是样本内残差：
   * 6 个参数只有 9 个点，样本内残差必然偏乐观（实测样本内 ~1.5% 而留一 ~3~5%）。
   * 用户看到的是留一误差，也就是「换个新位置大概差多少」。
   *
    * @param {Array<{f:object, tx:number, ty:number}>} samples 每个标定点一条（已取中位数）
    *        在线学习的点击样本额外带 {kind:'click', t}；标定样本不带 kind（等价于 kind:'calib'）
    * @param {object} [opts]
    * @param {number} [opts.now] 当前时间戳（ms），用于点击样本的时间衰减
    * @param {number} [opts.halfLifeMs] 点击样本权重半衰期
    */
  static fit(samples, { aspect = 4 / 3, ridge = 0.01, created = 0, now = 0, halfLifeMs = CLICK_HALF_LIFE_MS } = {}) {
    const pts = (samples || []).filter(
      (s) => s && s.f && isFinite(s.tx) && isFinite(s.ty) && FEATURES.every((k) => isFinite(s.f[k])),
    );
    if (pts.length < MIN_SAMPLES) {
      return new GazeCalibModel({ ok: false, reason: 'insufficient', n: pts.length, aspect, created });
    }
    // 点击样本按年龄衰减加权；没有点击样本时返回 null ⇒ 后续全程走无权重的旧路径
    const weights = sampleWeights(pts, now, halfLifeMs);

    // 两套特征集：各自在 λ 网格上挑配置，再按 1-SE 规则二选一（见下）。
    // 挑 λ 时不是「留一误差最小就赢」：留一误差只覆盖「同一坐姿内的新注视点」，
    // 完全看不到「演示时微动一下会不会跳」这一维。2026-10-20 真机数据里，纯按留一最优选出的
    // λ 会让「脸前后动 0.1%」把光标推走 12.5% 屏高——所以先筛掉超敏感度预算的配置，
    // 在达标者里再按留一比精度；一个都不达标时退而求其次，取最不敏感的那个。
    const grid = Array.from(new Set([...(isFinite(ridge) ? [ridge] : []), ...LAMBDA_GRID])).sort((a, b) => a - b);
    const cands = [];
    for (const name of Object.keys(TERM_SETS)) {
      const set = TERM_SETS[name];
      const tried = [];
      for (const lam of grid) {
        const r = looScore(pts, lam, aspect, set, weights);
        if (r) tried.push({ ...r, lam, sensWorst: Math.max(r.sens.head, r.sens.dist, r.sens.tilt) });
      }
      if (!tried.length) continue;
      const safe = tried.filter((t) => t.sensWorst <= SENS_LIMIT);
      const pool = safe.length ? safe : tried;
      // 达标者比留一误差；无人达标时比敏感度（同分再比留一）
      pool.sort((a, b) => (safe.length ? a.avgErr - b.avgErr : a.sensWorst - b.sensWorst || a.avgErr - b.avgErr));
      const scored = pool[0];
      cands.push({
        name,
        ...scored,
        quality: {
          avgErr: scored.avgErr,
          maxErr: scored.maxErr,
          fitErr: scored.fitErr,
          cv: scored.cv,
          grade: scored.avgErr <= GRADE_LIMITS.good ? 'good' : scored.avgErr <= GRADE_LIMITS.ok ? 'ok' : 'poor',
        },
      });
    }
    if (!cands.length) {
      return new GazeCalibModel({ ok: false, reason: 'singular', n: pts.length, aspect, created });
    }

    // 选特征集：先取留一平均误差最小的那套（best），再做 1-SE 规则——
    // 若另一套的误差落在「best ± 一个标准误」内，就取**参数更少**的那套。
    // 理由：full 多了 faceCx/faceCy 两个头动项。标定时头几乎不动的话（真机见 rawStd.faceCx=0.0014），
    // 这两项是在噪声里拟合出来的，用它只换来微不足道的精度，却让"演示时头一动光标就跳"（实测系数
    // 可达 0.13 归一化单位/1% 头动）。统计上也标准（Breiman 的 one-standard-error rule）。
    cands.sort((a, b) => a.avgErr - b.avgErr);
    const best = cands[0];
    const errs = best.looErr.filter((v) => isFinite(v));
    const se = errs.length > 1 ? stddev(errs, avg(errs)) / Math.sqrt(errs.length) : 0;
    const limit = best.avgErr + se;
    const eligible = cands.filter((c) => c.avgErr <= limit);
    eligible.sort((a, b) => (a.terms - b.terms) || (a.avgErr - b.avgErr));
    const pick = eligible[0] || best;

    const model = new GazeCalibModel({
      ok: true,
      reason: '',
      aspect,
      created,
      n: pts.length,
      variant: pick.name,
      termsX: TERM_SETS[pick.name].x,
      termsY: TERM_SETS[pick.name].y,
      mean: pick.core.mean,
      std: pick.core.std,
      wx: pick.core.wx,
      wy: pick.core.wy,
      points: pick.points,
      quality: pick.quality,
    });

    // ---- 诊断：把「为什么准 / 为什么不准」变成可读信息（采集端的帧级统计会合并进来）----
    const st = pts.map((p) => p.stats).filter(Boolean);
    const diag = { ...best.core.stats };
    diag.variant = pick.name;
    diag.scores = {};
    diag.lambdas = {};
    for (const c of cands) {
      diag.scores[c.name] = c.avgErr;
      diag.lambdas[c.name] = c.lam;
    }
    diag.lambda = pick.lam;
    diag.se = se;
    // 是否因为「1-SE 规则」选了参数更少的那套（诊断要据此换一种说法）
    diag.pickedBySE = pick !== best;
    // 在线学习（点击即训练）的状态：weighted=false 表示这次拟合没有任何点击样本，
    // 结果与「纯 9 点标定」逐位一致（排查精度回退时可以先看这个开关）
    diag.weighted = !!weights;
    diag.nClick = pts.filter((p) => p.kind === 'click').length;
    diag.looErr = pick.looErr.map((v) => (isFinite(v) ? Math.round(v * 1e4) / 1e4 : null));
    diag.frames = st.length ? Math.round(avg(st.map((s) => s.n || 0))) : null;
    diag.jitter = st.length ? median(st.map((s) => s.jitter || 0)) : null;
    diag.headRange = st.length ? median(st.map((s) => s.headRange || 0)) : null;
    diag.openness = st.length ? median(st.map((s) => s.openness || 0)) : null;
    diag.dropped = st.reduce((a, s) => a + (s.dropped || 0), 0);
    diag.worstAt = pick.worstAt;
    // 演示鲁棒性：小动作引起的光标位移（留一误差看不到这一维）
    const sens = pick.sens;
    diag.sens = { ...sens, limit: SENS_LIMIT };
    diag.sensWorst = Math.max(sens.head, sens.dist, sens.tilt);
    diag.sensOk = diag.sensWorst <= SENS_LIMIT;
    model.diag = diag;

    // ---- 退化门：不合格就明确失败，绝不把废模型交给光标 ----
    // 依据是 2026-10-20 实测事故：真人标定留一误差 50.4%，但旧代码因为 MIN_STD 只夹分母
    // 依然标 ok，预测点撒满全屏。宁可让用户「重做」，也不要给出乱飞的光标。
    const reasons = [];
    if (diag.eyeStdX < MIN_EYE_STD.x || diag.eyeStdY < MIN_EYE_STD.y) reasons.push('weak-eye-signal');
    if (best.avgErr > MAX_ACCEPT_ERR) reasons.push('poor-fit');
    if (reasons.length) {
      model.ok = false;
      model.reason = reasons[0];
      model.reasons = reasons;
    }
    return model;
  }

  /** @returns {{x:number,y:number,conf:number}|null} 屏幕归一化坐标 */
  predict(f) {
    if (!this.ok || !f || !this.mean || !this.std) return null;
    for (const k of FEATURES) if (!isFinite(f[k])) return null;
    const x = clamp01(dotStd(this.wx, this.termsX, f, this.mean, this.std));
    const y = clamp01(dotStd(this.wy, this.termsY, f, this.mean, this.std));
    const avgErr = (this.quality && this.quality.avgErr) || 0.08;
    const conf = clamp01(1 - avgErr / 0.15);
    return { x, y, conf: Math.max(0.15, conf) };
  }

  toJSON() {
    return {
      // v3：特征集变成可选的（full/reduced），权重长度随 terms 变化；v2 及更早一律拒绝加载
      v: 3,
      ok: this.ok,
      reason: this.reason,
      variant: this.variant,
      termsX: this.termsX,
      termsY: this.termsY,
      aspect: this.aspect,
      created: this.created,
      n: this.n,
      mean: this.mean,
      std: this.std,
      wx: this.wx,
      wy: this.wy,
      quality: this.quality,
      points: this.points,
      diag: this.diag,
    };
  }

  static fromJSON(obj) {
    if (!obj || typeof obj !== 'object' || obj.v !== 3 || !obj.ok) return null;
    const m = new GazeCalibModel(obj);
    // 严格校验：缺一项就没法预测，宁可当「未标定」也不要带着坏模型跑
    if (!m.mean || !m.std || !Array.isArray(m.wx) || !Array.isArray(m.wy)) return null;
    if (m.wx.length !== m.termsX.length + 1 || m.wy.length !== m.termsY.length + 1) return null;
    for (const k of m.termsX.concat(m.termsY)) if (FEATURES.indexOf(k) < 0) return null;
    for (const w of [m.wx, m.wy]) {
      for (const v of w) if (!isFinite(v)) return null;
    }
    for (const k of FEATURES) {
      if (!isFinite(m.mean[k]) || !isFinite(m.std[k]) || !(m.std[k] > 0)) return null;
    }
    // 质量门槛：即使存的是 ok:true，误差超过可用上限也不加载
    // （旧代码曾把 50.4% 的废模型标成 ok 存下来，这一条专门挡住这类脏数据）
    if (m.quality && isFinite(m.quality.avgErr) && m.quality.avgErr > MAX_ACCEPT_ERR) return null;
    if (!isFinite(m.aspect) || m.aspect <= 0.1) m.aspect = 4 / 3;
    return m;
  }
}

/**
 * 把诊断数据翻译成「用户能照着做」的中文提示（结果页直接逐行显示）。
 * 设计原则：先说结论（能不能用），再说原因，最后给一句可执行建议。
 * @param {GazeCalibModel|null} model
 * @returns {string[]}
 */
/** 把归一化坐标翻成九宫格方位词（用于"最差的是哪一块"这类诊断） */
function zoneName(pt) {
  const x = pt[0];
  const y = pt[1];
  const hz = x < 0.34 ? '左' : x > 0.66 ? '右' : '';
  const vz = y < 0.34 ? '上' : y > 0.66 ? '下' : '';
  if (vz && hz) return `屏幕${hz}${vz}角`;
  if (vz) return `屏幕${vz}边中间`;
  if (hz) return `屏幕${hz}边中间`;
  return '屏幕正中';
}

export function diagnoseText(model) {
  const pc = (v) => `${(Number(v) * 100).toFixed(1)}%`;
  if (!model) return ['还没做标定：点「重新标定」跟完 9 个点即可。'];
  const d = model.diag || {};
  const q = model.quality || {};

  if (model.reason === 'insufficient') {
    return [
      `有效标定点只有 ${model.n} 个（至少需要 ${MIN_SAMPLES} 个）：采集期间多半没检测到人脸（光线不足、脸太小、频繁眨眼）。`,
      '建议：正对摄像头、把脸靠近到画面 1/3 以上，再重做一次。',
    ];
  }
  if (model.reason === 'singular') return ['标定数据病态（特征共线或某个点完全重复），无法求解，请重做。'];

  const out = [];
  const s = d.scores || {};
  if (isFinite(s.full) && isFinite(s.reduced)) {
    // "明显"的统一尺度 = 留一误差的 1 个标准误（与 1-SE 择优规则一致），不再用拍出来的倍数
    const se = isFinite(d.se) ? d.se : 0;
    if (d.pickedBySE) {
      // 1-SE 规则选中的：两套差别不显著 → 取参数更少的纯眼球模型（更抗头动）
      out.push(
        `两套模型的精度差别在噪声范围内（含头动项 ${pc(s.full)}、纯眼球 ${pc(s.reduced)}）：按「差别不显著就选更简单的」规则，已采用纯眼球模型——你演示时头怎么动，光标都不会突然跳（代价是头动补偿弱一点）。`,
      );
    } else if (d.variant === 'reduced') {
      out.push(
        `含头动项的模型明显更差（${pc(s.full)} vs ${pc(s.reduced)}）：标定期间头部移动污染了数据，已自动改用纯眼球模型。下次标定时让下巴别动。`,
      );
    } else if (s.reduced - s.full > se) {
      out.push(
        `含头动项的模型明显更好（${pc(s.full)} vs ${pc(s.reduced)}）：你标定时头有配合移动，已保留头动补偿（换坐姿后更稳）。`,
      );
    } else {
      out.push(
        `两套模型精度几乎一样（含头动项 ${pc(s.full)}、纯眼球 ${pc(s.reduced)}）：保留了头动补偿，你配合移动时会更稳。`,
      );
    }
  }
  const weakEye = d.eyeStdX != null && (d.eyeStdX < MIN_EYE_STD.x || d.eyeStdY < MIN_EYE_STD.y);
  if (weakEye) {
    out.push(
      `眼球位移信号太弱（横向 ${pc(d.eyeStdX)}、纵向 ${pc(d.eyeStdY)} 眼宽）：标定时眼睛几乎没有跟着点动，或者脸离摄像头太远/光线不足，虹膜关键点本身就不准。`,
    );
    out.push('建议：只动眼睛别动头；脸靠近摄像头到画面 1/3 以上；正面朝向光源（别背光、别让灯在身后）；然后重做。');
  }
  if (model.reasons && model.reasons.indexOf('poor-fit') >= 0) {
    out.push(
      `模型跟不上你的注视（平均留一误差 ${pc(q.avgErr || 0)}，超过可用上限 ${pc(MAX_ACCEPT_ERR)}）：这组数据里「眼球位置」和「你看哪里」没有稳定关系。`,
    );
    out.push('常见原因：跟点时用转头代替转眼、眼睛没等红点就位、或这台摄像头的虹膜关键点不可靠。建议严格「只动眼睛」重做一次。');
  }
  if (d.headMove != null && d.headMove > HEAD_MOVE_WARN) {
    out.push(
      `标定期间头部移动偏大（${pc(d.headMove)} 画面宽）：头一动，同一条视线对应的虹膜位置就变了，模型会去拟合头动。下次下巴别动、只转眼球。`,
    );
  }
  if (d.jitter != null && d.jitter > 0.02) {
    out.push(`帧内抖动偏大（${pc(d.jitter)} 眼宽）：补光 + 靠近摄像头能明显改善。`);
  }
  if (d.corrX != null && d.corrX < 0.5) {
    out.push(`虹膜横向位移与注视目标的相关系数只有 ${Number(d.corrX).toFixed(2)}（正常应 > 0.8），横向注视几乎没有反映到虹膜位移上。`);
  }
  if (d.dropped) out.push(`已自动剔除 ${d.dropped} 个离群帧（眨眼/跳变），不影响上面的结论。`);

  if (model.ok) {
    const g = q.grade === 'good' ? '优' : q.grade === 'ok' ? '良' : '偏低';
    const avg = q.avgErr || 0;
    // 建议按评级分档：不能只因为"能过质量门"就承诺四角也准（首次真人实测就是这么翻车的）
    const mx = q.maxErr || 0;
    const advice =
      avg <= GRADE_LIMITS.good
        ? mx <= GRADE_LIMITS.good
          ? '中心区和四角按钮基本都能命中。'
          : `中心区很稳，个别方位仍会偏（最差 ${pc(mx)}）：那一片的按钮放大一点，或挪到中间。`
        : avg <= GRADE_LIMITS.ok
          ? '中心区按钮可以正常注视点击；越靠近四角越容易偏，重要按钮尽量放中间。'
          : '误差偏大，建议配合放大目标使用，或重做一次。';
    out.push(`本次标定可用：留一误差 平均 ${pc(avg)} / 最大 ${pc(q.maxErr || 0)}，评级 ${g}。${advice}`);
    // 最大误差落在哪个方位（现场据此决定按钮摆哪）
    if (d.worstAt && (avg > GRADE_LIMITS.good || mx > GRADE_LIMITS.good)) {
      out.push(`误差最大的是${zoneName(d.worstAt)}那个点（约 ${pc(q.maxErr || 0)} 屏宽）：这块区域的小按钮先别指望，重要操作放中心。`);
    }
  } else if (!out.length) {
    out.push('本次标定不可用，请重做。');
  }
  return out;
}

/* ---------------------------------------------------------------- 光标来源 */

/**
 * 精确注视光标来源：有可用模型时输出「绝对屏幕坐标」，否则退回代理实现（虹膜相对偏移）。
 * 与 GazeCursorSource 接口一致，可直接替换进 app.js。
 */
export class AbsoluteGazeSource {
  constructor({ model = null, gain = 2.0, margin = 0.04, aspect = 4 / 3 } = {}) {
    this.fallback = new GazeCursorSource({ gain, margin });
    this.aspect = aspect;
    this.model = model && model.ok ? model : null;
  }

  setModel(model) {
    this.model = model && model.ok ? model : null;
  }

  get active() {
    return !!(this.model && this.model.ok);
  }

  reset() {
    if (this.fallback && this.fallback.reset) this.fallback.reset();
  }

  getPoint(faceResults) {
    const faces = faceResults && faceResults.multiFaceLandmarks;
    if (!faces || !faces.length) return null;
    const lm = faces[0];
    if (!lm || lm.length < 478) return null;

    // 特征每帧都算一次并缓存：即使当前是 fallback（还没有模型），点击采样也要能取到
    // 「与预测同一条提取路径」的特征——同分布是点击即训练有效的隐含前提。
    const asp = (this.model && this.model.aspect) || this.aspect;
    const f = extractFeatures(lm, asp);
    this._lastFeatures = f || null;
    this._lastFeaturesAt = f ? Date.now() : 0;

    if (this.model && f) {
      const p = this.model.predict(f);
      if (p) return p;
    }
    return this.fallback.getPoint(faceResults);
  }

  /** 最近一帧的特征向量（点击即训练采样用）；无有效人脸时为 null */
  get lastFeatures() {
    return this._lastFeatures || null;
  }

  /** 最近一帧特征的采集时刻（Date.now 基准，0=还没有）。调用方据此判断特征是否新鲜 */
  get lastFeaturesAt() {
    return this._lastFeaturesAt || 0;
  }
}

/* ---------------------------------------------------------------- 演示用合成人脸 */

/**
 * 生成「正在看目标点」的合成 478 点关键点（仅自动演示与自测使用）。
 * 页面坐标 → 图像帧虹膜比值：页面越靠右，图像帧虹膜越靠左（镜像），
 * 因此用它标定出的模型会自己学到这个反向关系，和真人标定走同一条代码路径。
 */
export function simLandmarksFor(tx, ty, aspect = 4 / 3, { noise = 0, gain = 0.9, rnd = Math.random } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const jit = () => (noise ? (rnd() - 0.5) * 2 * noise : 0);
  const eyeW = 0.052;
  const eyeH = 0.02;
  const cy = 0.42;
  const lOuter = { x: 0.4, y: cy };
  const lInner = { x: 0.4 + eyeW, y: cy };
  const rInner = { x: 0.6 - eyeW, y: cy };
  const rOuter = { x: 0.6, y: cy };
  const hx = 0.5 - (tx - 0.5) * gain;
  const hy = 0.5 + (ty - 0.5) * gain;
  const put = (i, x, y) => {
    lm[i] = { x: x + jit(), y: y + jit() };
  };
  put(33, lOuter.x, lOuter.y);
  put(133, lInner.x, lInner.y);
  put(263, rOuter.x, rOuter.y);
  put(362, rInner.x, rInner.y);
  put(159, (lOuter.x + lInner.x) / 2, cy - eyeH / 2);
  put(145, (lOuter.x + lInner.x) / 2, cy + eyeH / 2);
  put(386, (rInner.x + rOuter.x) / 2, cy - eyeH / 2);
  put(374, (rInner.x + rOuter.x) / 2, cy + eyeH / 2);
  put(468, lOuter.x + hx * eyeW, cy - eyeH / 2 + hy * eyeH);
  put(473, rInner.x + hx * eyeW, cy - eyeH / 2 + hy * eyeH);
  return lm;
}

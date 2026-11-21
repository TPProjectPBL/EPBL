/**
 * @file 眼动特征：常量、统计工具、478 点特征提取、演示用合成人脸。
 *
 * 从 `eye-page-turner/demo/air-runner/lib/gaze-calib.js` 原样迁移，
 * 数值、算法与注释均未改动。迁移时间：2026-11-19。
 */
import { mirrorLandmarks } from './mirror.js';

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
export const MIN_STD = {
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

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
export function wmean(list, w) {
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
export function wstd(list, mean, w) {
  let s = 0;
  let sw = 0;
  for (let i = 0; i < list.length; i++) {
    const wi = w[i] > 0 ? w[i] : 0;
    s += wi * (list[i] - mean) * (list[i] - mean);
    sw += wi;
  }
  return sw > 1e-9 ? Math.sqrt(s / sw) : 0;
}

export function avg(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const v of list) s += v;
  return s / list.length;
}

export function stddev(list, mean) {
  if (list.length < 2) return 0;
  let s = 0;
  for (const v of list) s += (v - mean) * (v - mean);
  return Math.sqrt(s / (list.length - 1));
}

export function median(list) {
  if (!list.length) return 0;
  const a = list.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 皮尔逊相关系数；任一侧没有方差（或样本太少）时返回 0 */
export function corr(xs, ys) {
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

/**
 * 镜像后的特征提取（统一标定协议）。
 * 与 {@link extractFeatures} 完全相同的算法，只是先把所有点 x 换成 1 - x。
 */
export function extractFeaturesMirrored(lm, aspect = 4 / 3) {
  const m = mirrorLandmarks(lm);
  return m ? extractFeatures(m, aspect) : null;
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

/**
 * @file 统一标定协议（唯一参数源）。
 *
 * 规则来自产品定稿：
 *   - 每次进入标定页强制 9 点，无跳过
 *   - 先出摄像头弹窗：头稳定后才 3-2-1 开始
 *   - 每点固定停留采样 1000ms；不稳定只丢帧，不重来
 *   - 等权岭回归，alpha 固定 1.0，二阶多项式特征
 *   - 9 点后 5 点验证（全屏四角 + 中心），各 1000ms
 *   - 正确率 >= 60 分通过，否则提示重标（允许跳过）
 *   - 模型覆盖写入 IndexedDB 固定键 gaze_model
 *
 * 任何页面都不得复制这里的数字。
 */

/** 9 点标定阵（3×3，PAGE_NORM 坐标）。 */
export const CALIB_POINTS = Object.freeze([
  { tx: 0.1, ty: 0.12 },
  { tx: 0.5, ty: 0.12 },
  { tx: 0.9, ty: 0.12 },
  { tx: 0.1, ty: 0.5 },
  { tx: 0.5, ty: 0.5 },
  { tx: 0.9, ty: 0.5 },
  { tx: 0.1, ty: 0.88 },
  { tx: 0.5, ty: 0.88 },
  { tx: 0.9, ty: 0.88 },
]);

/** 5 点验证阵（全屏四角 + 中心）。 */
export const VALIDATE_POINTS = Object.freeze([
  { tx: 0.06, ty: 0.06 },
  { tx: 0.94, ty: 0.06 },
  { tx: 0.5, ty: 0.5 },
  { tx: 0.06, ty: 0.94 },
  { tx: 0.94, ty: 0.94 },
]);

/** 单点固定采样窗口（ms）。不稳定只丢帧，进度不会回落。 */
export const SAMPLE_MS = 1000;

/** 采样期间期望的最短有效帧数；低于此值该点标记为 weak，但仍然入样。 */
export const MIN_FRAMES = 8;

/** 一帧有效画面都没有时的最少入样帧数：3 帧就够算均值，否则跳过该点。 */
export const POINT_MIN_SAMPLE_FRAMES = 3;

/** 单点墙钟上限（ms）：头一直不稳时也不会卡死，到点按已有帧结算。 */
export const POINT_TIMEOUT_MS = 8000;

/** 眨眼判定：EAR 低于此值算闭眼，重置当前点。 */
export const EAR_MIN = 0.2;

/**
 * 单帧采样时长上限（ms）。
 *
 * 进度只能由「有效帧」累加，且单帧最多计这么久：摄像头掉帧、标签页被节流、
 * 推理卡顿时不会因为墙钟走了 1 秒就把一个没人看的点判成采样完成。
 */
export const FRAME_DT_MAX_MS = 120;

/** 判定「摄像头没有新帧」的时限（ms）；超过即停止推进，等画面恢复。 */
export const FRAME_STALE_MS = 400;

/** 同一采样窗口内，眼球特征（虹膜相对眼眶）的标准差超过此值视为视线游走，丢弃该帧。 */
export const GAZE_JITTER_MAX = 0.12;

/** 单帧偏离窗口均值超过此值（眼宽比例）视为离群帧，丢弃但不重置本点。 */
export const FRAME_OUTLIER_MAX = 0.28;

/**
 * 相邻两个标定点之间的眼球特征最小位移。
 *
 * 用户如果没有真正看向靶点（例如盯着键盘），眼睛几乎不动，9 个点会采到同一组
 * 特征，拟合出来必然是一个「光标撒满全屏」的废模型。这个门槛直接拒绝该点。
 */
export const MIN_GAZE_DELTA = 0.012;

/** 等权岭回归系数（固定）。 */
export const RIDGE_ALPHA = 1.0;

/** 验证通过阈值：5 点平均欧氏距离（PAGE_NORM）。 */
export const PASS_DIST = 0.08;

/**
 * 百分制正确率的换算跨度。
 *
 * 单点正确率 = clamp(1 - 误差 / SCORE_SPAN, 0, 1) × 100，即误差每 0.04 扣 10 分：
 * 0.00 → 100 分，0.04 → 90 分，0.08 → 80 分，0.16（合格线）→ 60 分，0.20 → 50 分。
 */
export const SCORE_SPAN = 0.4;

/** 通过线（百分制）：60 分，等价于平均误差 <= 0.16。 */
export const PASS_SCORE = 60;

/** 单点误差 → 百分制分数。 */
export function scoreOf(dist) {
  if (!Number.isFinite(dist)) return 0;
  return Math.max(0, Math.min(1, 1 - dist / SCORE_SPAN)) * 100;
}

/** 两点之间的停顿（ms）：让被试有时间把视线移到下一个靶点。 */
export const POINT_GAP_MS = 1000;

/** 开始前的准备倒计时（秒）。 */
export const COUNTDOWN_FROM = 3;

/**
 * 摄像头弹窗里「头稳定」的判定：
 * 连续这么多个有效帧姿态合格才记录基准头位，再多这么多帧才允许倒计时开始。
 * 口径与热力图融合前版本一致（headGate / contract.HEAD）。
 */
export const READY_REF_STREAK = 6;
export const READY_STABLE_STREAK = 12;

/** 训练使用的原始特征（眼球 4 维）。二阶展开见 poly2.js。 */
export const FEATURE_KEYS = Object.freeze(['dLx', 'dLy', 'dRx', 'dRy']);

/** IndexedDB 位置与固定键名。 */
export const IDB = Object.freeze({
  db: 'epbl-gaze',
  store: 'models',
  key: 'gaze_model',
  version: 1,
});

/** 模型 schema 版本；不兼容变更必须升版并提供迁移。 */
export const MODEL_VERSION = 2;

/** 阶段名（UI 与宿主共用）。 */
export const PHASE = Object.freeze({
  IDLE: 'idle',
  READY: 'ready',
  CALIB: 'calib',
  FIT: 'fit',
  VALIDATE: 'validate',
  REVIEW: 'review',
  RESULT: 'result',
});

/** 采样中断原因（写给用户看的文案）。 */
export const RESET_REASON = Object.freeze({
  noFace: '未检测到人脸 · 请正对摄像头',
  blink: '眨眼 · 该帧已丢弃',
  head: '头位偏离 · 该帧已丢弃',
  weak: '有效帧偏少 · 该点已按现有数据记录',
  jitter: '视线晃动 · 该帧已丢弃',
  noGaze: '没有检测到视线移动 · 该点已跳过',
  stale: '摄像头没有新画面 · 等画面恢复',
});

/**
 * 把任意输入归一成 {@link CALIB_POINTS} 形状。
 * @param {Array<[number,number]|{tx:number,ty:number}>} list
 * @returns {Array<{tx:number,ty:number}>}
 */
export function toPoints(list) {
  return (list || []).map((p) =>
    Array.isArray(p) ? { tx: Number(p[0]), ty: Number(p[1]) } : { tx: Number(p.tx), ty: Number(p.ty) },
  );
}

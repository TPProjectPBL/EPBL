/**
 * @file 手眼标定契约 v1 的运行时层：常量 + 纯函数。
 *
 * 本文件是 `CONTRACT.md` 的可执行版本。页面只允许依赖这里导出的值，
 * 不得在各自的脚本里复制阈值、键名或坐标换算。
 *
 * 无第三方依赖；可在浏览器 ES module、Node ESM、打包器中使用。
 *
 * @module shared/gaze/contract
 */

/**
 * 当前数据 schema 版本。
 * 不兼容变更时必须同步升到 2，并提供迁移函数。
 * @constant {number}
 */
export const SCHEMA_VERSION = 1;

/**
 * 唯一允许使用的 localStorage 键。
 * 旧键（如 `air-runner.gazeModel`）只读不写。
 * @constant {{model: string, samples: string, settings: string}}
 */
export const STORE_KEYS = Object.freeze({
  model: 'epbl.gaze.model.v1',
  samples: 'epbl.gaze.samples.v1',
  settings: 'epbl.gaze.settings.v1',
});

/**
 * 坐标空间标识。
 * - `PAGE`：页面归一化，跨层传输格式
 * - `VIDEO`：视频帧归一化，仅用于特征
 * @constant {{PAGE: string, VIDEO: string}}
 */
export const COORD = Object.freeze({
  PAGE: 'page-norm',
  VIDEO: 'video-norm',
});

/**
 * 标定质量阈值，全部是 PAGE_NORM 空间的量。
 * - `good`   平均误差 <= 0.05 判优
 * - `ok`     平均误差 <= 0.09 判良
 * - `reject` 平均误差 >  0.25 拒绝保存
 * - `sens`   敏感度上限
 * @constant {{good: number, ok: number, reject: number, sens: number}}
 */
export const LIMITS = Object.freeze({
  good: 0.05,
  ok: 0.09,
  reject: 0.25,
  sens: 0.03,
});

/**
 * 头部姿态门控阈值。
 *
 * 口径来自热力图旧实现（`readHead()`），三页共用同一组数：
 *   - 硬门控：人脸框大小 / 位置 / 姿态角，判断"这一帧能不能用"
 *   - 基准门控：相对标定时头位的偏差，判断"头有没有离开标定位置"
 *
 * 坐标均为归一化量；角度单位为度。
 * @constant {object}
 */
export const HEAD = Object.freeze({
  distMin: 0.22,
  distMax: 0.8,
  centerX: 0.17,
  centerY: 0.2,
  rollMax: 12,
  yawMax: 17,
  pitchMin: 5,
  pitchMax: 68,
  refDx: 0.055,
  refDy: 0.065,
  refDh: 0.1,
  refRoll: 5,
  refYaw: 7,
  refPitch: 8,
  blinkEar: 0.17,
});

/**
 * 验证阶段专用的头位门控：硬门控（距离/居中/姿态角）与标定一致，
 * 只放宽「相对标定基准的偏移」这一组阈值。
 *
 * 原因：验证要用户主动看左上/右下等边缘靶点，头必然会朝靶点转动；
 * 若沿用标定的严格基准（yaw±7°、dx±0.055），看边缘点时会整秒判 head 丢弃，
 * 出现「0 有效帧 / 满丢弃 / 0 分」的假象，反映的是门控而非真实精度。
 * 标定阶段仍用严格 HEAD，保证进模型的样本头位稳定。
 */
export const HEAD_VALIDATE = Object.freeze({
  ...HEAD,
  refDx: 0.14,
  refDy: 0.16,
  refDh: 0.2,
  refRoll: 12,
  refYaw: 18,
  refPitch: 20,
});

/**
 * 9 点标定的点阵与时间参数。
 * 坐标均为 PAGE_NORM。
 * @constant {{cols: readonly number[], rows: readonly number[], settleMs: number, collectMs: number, minFrames: number}}
 */
export const CALIB = Object.freeze({
  cols: Object.freeze([0.1, 0.5, 0.9]),
  rows: Object.freeze([0.12, 0.5, 0.88]),
  settleMs: 350,
  collectMs: 1200,
  minFrames: 6,
});

/**
 * 把 PAGE_NORM 的误差换算成像素。
 *
 * 使用视口对角线长度，而不是宽或高：
 * `errPx = err * hypot(w, h)`
 *
 * @param {number} err PAGE_NORM 空间的距离，通常来自 `hypot(dx, dy)`
 * @param {number} w 视口宽度（CSS px）
 * @param {number} h 视口高度（CSS px）
 * @returns {number} 像素误差；参数非法时返回 `NaN`
 */
export function errToPx(err, w, h) {
  const e = Number(err);
  const vw = Number(w);
  const vh = Number(h);
  if (!Number.isFinite(e)) return NaN;
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return NaN;
  return e * Math.hypot(vw, vh);
}

/**
 * 把数值夹到 `0..1`。
 *
 * - `NaN` 原样返回 `NaN`（表示"没有数据"，不要伪装成 0）
 * - 正负无穷分别夹到 `1` / `0`
 *
 * @param {number} v 任意数值
 * @returns {number} `0..1` 之间的值，或 `NaN`
 */
export function clamp01(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return NaN;
  return Math.min(1, Math.max(0, n));
}

/**
 * 把视口描述统一成 `宽x高` 字符串。
 * @param {{w?: number, h?: number, width?: number, height?: number, innerWidth?: number, innerHeight?: number}|string|null|undefined} viewport
 * @returns {string}
 */
function normalizeViewport(viewport) {
  if (!viewport) return '';
  if (typeof viewport === 'string') return viewport.trim();
  const w = viewport.w ?? viewport.width ?? viewport.innerWidth;
  const h = viewport.h ?? viewport.height ?? viewport.innerHeight;
  const nw = Number(w);
  const nh = Number(h);
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return '';
  return `${Math.round(nw)}x${Math.round(nh)}`;
}

/**
 * 把摄像头描述统一成 `宽x高` 字符串。
 * @param {{w?: number, h?: number, width?: number, height?: number, videoWidth?: number, videoHeight?: number}|string|null|undefined} camera
 * @returns {string}
 */
function normalizeCamera(camera) {
  if (!camera) return '';
  if (typeof camera === 'string') return camera.trim();
  const w = camera.w ?? camera.width ?? camera.videoWidth;
  const h = camera.h ?? camera.height ?? camera.videoHeight;
  const nw = Number(w);
  const nh = Number(h);
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return '';
  return `${Math.round(nw)}x${Math.round(nh)}`;
}

/**
 * 把 dpr 归一成两位小数的字符串。
 * @param {number|string|null|undefined} dpr
 * @returns {string}
 */
function normalizeDpr(dpr) {
  if (dpr === null || dpr === undefined || dpr === '') return '';
  const n = Number(dpr);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 100) / 100);
}

/**
 * 特征名集合归一：去空、去重、排序、用 `+` 连接。
 * 排序保证 `['roll','dLx']` 与 `['dLx','roll']` 得到同一签名。
 * @param {string[]|null|undefined} terms
 * @returns {string}
 */
function normalizeTerms(terms) {
  if (!Array.isArray(terms)) return '';
  const set = new Set();
  for (const t of terms) {
    const s = String(t || '').trim();
    if (s) set.add(s);
  }
  return [...set].sort().join('+');
}

/**
 * 构造签名字符串的规范形式（字段固定顺序，与对象 key 顺序无关）。
 * @param {{viewport?: any, dpr?: any, camera?: any, engine?: any, terms?: any}} input
 * @returns {string}
 */
function canonicalize(input) {
  const engine = input && input.engine ? String(input.engine).trim() : '';
  return [
    `camera=${normalizeCamera(input && input.camera)}`,
    `dpr=${normalizeDpr(input && input.dpr)}`,
    `engine=${engine}`,
    `terms=${normalizeTerms(input && input.terms)}`,
    `viewport=${normalizeViewport(input && input.viewport)}`,
  ].join('|');
}

/**
 * FNV-1a 32 位哈希，输出 8 位小写十六进制。
 * @param {string} str
 * @returns {string}
 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 生成模型签名：把环境与特征归一后拼成稳定字符串，再做 32 位 hash。
 *
 * 同一环境、同一特征集合必须得到同一签名；字段顺序、数组顺序不影响结果。
 *
 * @param {{
 *   viewport?: {w: number, h: number}|string,
 *   dpr?: number|string,
 *   camera?: {w: number, h: number}|string,
 *   engine?: string,
 *   terms?: string[]
 * }} input 环境与特征描述
 * @returns {string} 形如 `v1-3f2a9c1b` 的签名
 *
 * @example
 * makeSignature({
 *   viewport: { w: 1440, h: 900 },
 *   dpr: 2,
 *   camera: { w: 640, h: 480 },
 *   engine: 'mediapipe-face-mesh-478',
 *   terms: ['roll', 'dLx', 'dRx', 'eyeDist'],
 * });
 * // => 'v1-<8 位 hash>'
 */
export function makeSignature(input) {
  const canonical = canonicalize(input || {});
  return `v1-${hash32(canonical)}`;
}

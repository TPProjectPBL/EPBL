/* 翻页指令生成（阶段 3）
 * 从检测信号中提取「上一页/下一页」方向，生成稳定、不误触的翻页指令。
 *  - 手势模式：手掌中心（中指掌指关节 9）在画面上下位置 → 上翻/下翻
 *  - 眼神模式：左眼虹膜相对眼眶的垂直偏移（视线上下）→ 上翻/下翻
 * 稳定策略：目标方向需连续 N 帧确认；触发后进入冷却；信号回中（死区）后才可再次触发。
 */

export const Direction = Object.freeze({
  PREV: 'prev',   // 上一页 / 向上翻
  NEXT: 'next',   // 下一页 / 向下翻
});

export class PageController {
  constructor(options = {}) {
    this.cooldownMs = options.cooldownMs ?? 800;   // 两次翻页最小间隔
    this.minFrames = options.minFrames ?? 5;       // 连续确认帧数
    this.onCommand = options.onCommand ?? null;
    this._candidate = null;
    this._candidateCount = 0;
    this._lastTriggerAt = 0;
  }

  /** 每帧调用；触发则返回方向，否则返回 null */
  update(direction) {
    const now = Date.now();
    if (now - this._lastTriggerAt < this.cooldownMs) {
      this._reset();
      return null;
    }
    if (!direction) {
      this._reset();
      return null;
    }
    if (this._candidate === direction) {
      this._candidateCount++;
    } else {
      this._candidate = direction;
      this._candidateCount = 1;
    }
    if (this._candidateCount >= this.minFrames) {
      this._lastTriggerAt = now;
      this._reset();
      if (this.onCommand) this.onCommand(direction);
      return direction;
    }
    return null;
  }

  _reset() {
    this._candidate = null;
    this._candidateCount = 0;
  }
}

/** 手势信号：手掌中心（landmark 9）Y 归一化，越靠近画面顶部值越小 */
export function gestureDirection(handLandmarks) {
  const p = handLandmarks && handLandmarks[9];
  if (!p) return null;
  if (p.y < 0.35) return Direction.PREV; // 手在上 → 上一页
  if (p.y > 0.65) return Direction.NEXT; // 手在下 → 下一页
  return null;
}

/** 眼神信号：左眼虹膜中心(468)相对眼眶(159上/145下)的垂直偏移，负=向上看 */
export function gazeDirection(faceLandmarks) {
  const iris = faceLandmarks && faceLandmarks[468];
  const top = faceLandmarks && faceLandmarks[159];
  const bottom = faceLandmarks && faceLandmarks[145];
  if (!iris || !top || !bottom) return null;
  const eyeCenter = (top.y + bottom.y) / 2;
  const eyeHeight = Math.abs(bottom.y - top.y) || 1e-6;
  const offset = (iris.y - eyeCenter) / eyeHeight;
  if (offset < -0.15) return Direction.PREV; // 向上看 → 上一页
  if (offset > 0.15) return Direction.NEXT;  // 向下看 → 下一页
  return null;
}

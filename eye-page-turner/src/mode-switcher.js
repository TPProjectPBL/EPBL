/* 阶段 2 · 模式切换器（ModeSwitcher）
 * 依据人屏距离在「眼神（近）/ 手势（远）」两模式间自动切换：
 *   - 阈值 1.5m，迟滞带 ±0.2m：距离 ∈ [1.3m, 1.7m] 为死区，保持当前模式不变。
 *   - 目标模式需连续确认 minFramesToSwitch 帧才真正切换，避免临界反复横跳。
 */

export const Mode = Object.freeze({
  GAZE: 'gaze',       // 眼神模式（近距离）
  GESTURE: 'gesture', // 手势模式（远距离）
});

export class ModeSwitcher {
  constructor(options = {}) {
    this.thresholdMeters = options.thresholdMeters ?? 1.5;
    this.hysteresisMeters = options.hysteresisMeters ?? 0.2;
    this.minFramesToSwitch = options.minFramesToSwitch ?? 5;
    this.mode = options.initialMode ?? Mode.GAZE;
    this.onSwitch = options.onSwitch ?? null;
    this._candidate = null;
    this._candidateCount = 0;
  }

  get upperBound() {
    return this.thresholdMeters + this.hysteresisMeters; // 1.7m
  }

  get lowerBound() {
    return this.thresholdMeters - this.hysteresisMeters; // 1.3m
  }

  update(distanceMeters) {
    // 无有效距离（如未检测到脸）时保持当前模式
    if (distanceMeters == null) return this.mode;

    let target = null;
    if (distanceMeters >= this.upperBound) {
      target = Mode.GESTURE; // 远距离 → 手势
    } else if (distanceMeters <= this.lowerBound) {
      target = Mode.GAZE;    // 近距离 → 眼神
    } else {
      return this.mode;      // 迟滞带内：保持
    }

    if (target === this.mode) {
      this._candidate = null;
      this._candidateCount = 0;
      return this.mode;
    }

    if (this._candidate === target) {
      this._candidateCount++;
    } else {
      this._candidate = target;
      this._candidateCount = 1;
    }

    if (this._candidateCount >= this.minFramesToSwitch) {
      const prev = this.mode;
      this.mode = target;
      this._candidate = null;
      this._candidateCount = 0;
      if (this.onSwitch) this.onSwitch(prev, this.mode, distanceMeters);
    }
    return this.mode;
  }
}

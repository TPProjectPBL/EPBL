/**
 * 三区注视选择器（跑酷变道）
 *
 * 报告里眼动最擅长的就是「离散区域选择」：把视口横向切成左 / 中 / 右三条注视带，
 * 视线落到某条带并停留 gazeMs，就切到对应车道。
 *
 * 为什么是 3 区而不是连续视线落点：
 *   - 跑酷变道本身是 3 个离散状态，误差容忍度极高（不像画画需要像素级精度）；
 *   - 不受阶段 3「眼神方向估计」未交付的影响，用虹膜代理坐标也足够稳；
 *   - 天然解决"所有注视都变成选择"的抖动问题 —— 只有跨区才产生动作。
 */

export class GazeZoneSelector {
  /**
   * @param {object} opts
   *   zones   默认左/中/右三区
   *   gazeMs  停留在区内多久才触发变道（跑酷节奏快，200–500ms）
   *   onSelect(zoneId, zone) 触发回调
   */
  constructor({ zones, gazeMs = 350, cooldownMs = 220, onSelect, onProgress } = {}) {
    this.zones = zones || [
      { id: 'left', x0: 0.0, x1: 0.34 },
      { id: 'center', x0: 0.34, x1: 0.66 },
      { id: 'right', x0: 0.66, x1: 1.0 },
    ];
    this.gazeMs = gazeMs;
    this.cooldownMs = cooldownMs;
    this.onSelect = onSelect || null;
    this.onProgress = onProgress || null;
    this.enabled = true;

    this.zone = null;
    this.dwellStart = 0;
    this.progress = 0;
    this._cooldownUntil = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this.zone = null;
      this.progress = 0;
    }
  }

  reset() {
    this.zone = null;
    this.dwellStart = 0;
    this.progress = 0;
    this._cooldownUntil = 0;
  }

  zoneAt(x) {
    for (const z of this.zones) {
      if (x >= z.x0 && x < z.x1) return z;
    }
    return this.zones[this.zones.length - 1];
  }

  /**
   * @param {{x:number,y:number}|null} cursor
   * @param {number} now
   * @returns {{zone:string|null, progress:number, fired:string|null}}
   */
  update(cursor, now) {
    if (!this.enabled || !cursor) {
      this.zone = null;
      this.progress = 0;
      return { zone: null, progress: 0, fired: null };
    }

    const z = this.zoneAt(cursor.x);

    if (!this.zone || this.zone.id !== z.id) {
      // 换区：重新开始计时（跨区才产生动作）
      this.zone = z;
      this.dwellStart = now;
      this.progress = 0;
      return { zone: z.id, progress: 0, fired: null };
    }

    if (now < this._cooldownUntil) {
      this.progress = Math.min(1, (now - this.dwellStart) / this.gazeMs);
      if (this.onProgress) this.onProgress({ id: z.id, progress: this.progress });
      return { zone: z.id, progress: this.progress, fired: null };
    }

    this.progress = Math.min(1, (now - this.dwellStart) / this.gazeMs);
    if (this.onProgress) this.onProgress({ id: z.id, progress: this.progress });

    if (this.progress >= 1) {
      this._cooldownUntil = now + this.cooldownMs;
      this.dwellStart = now;
      this.progress = 0;
      if (this.onSelect) this.onSelect(z.id, z);
      return { zone: z.id, progress: 0, fired: z.id };
    }
    return { zone: z.id, progress: this.progress, fired: null };
  }
}

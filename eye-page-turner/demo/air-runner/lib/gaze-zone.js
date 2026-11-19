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
 *
 * 稳定性（v2）：虹膜代理坐标逐帧抖动大，直接用单帧 x 判区会在边界反复横跳。
 * 这里加三层抑制，全部在 GazeZoneSelector 内部完成，外部接口不变：
 *   1) 多数表决：最近 voteN 帧的 x 各投一票，取票数最多的区；
 *   2) 迟滞（hysteresis）：候选区必须持续 switchMs 才真正切换；
 *   3) 置信度门控：cursor.conf 低于 minConf（眨眼/眯眼/脸偏）时跳过该帧，不推进停留。
 */

/** 左右识别带的边界（0–GAZE_SPLIT / GAZE_SPLIT–1-GAZE_SPLIT / 1-GAZE_SPLIT–1）。
 *  CSS 的识别带宽度由 app.js 用同一个值注入 --gaze-split，
 *  所以"看得见的范围"和"真正判定的范围"只有一个来源，改这里就够。 */
export const GAZE_SPLIT = 0.34;

const buildZones = (split) => [
  { id: 'left', x0: 0, x1: split },
  { id: 'center', x0: split, x1: 1 - split },
  { id: 'right', x0: 1 - split, x1: 1 },
];

export class GazeZoneSelector {
  /**
   * @param {object} opts
   *   zones      自定义分区（默认按 GAZE_SPLIT 三分）
   *   gazeMs     停留在区内多久才触发变道（跑酷节奏快，200–500ms）
   *   voteN      多数表决窗口帧数（5 ≈ 30fps 下 167ms）
   *   switchMs   换区迟滞：候选区需持续这么久才提交
   *   minConf    低于此置信度视为眨眼/眯眼，跳过该帧
   *   onSelect(zoneId, zone) / onProgress({id, progress})
   */
  constructor({
    zones,
    gazeMs = 350,
    cooldownMs = 220,
    onSelect,
    onProgress,
    voteN = 5,
    switchMs = 110,
    minConf = 0.22,
  } = {}) {
    this.zones = zones || buildZones(GAZE_SPLIT);
    this.gazeMs = gazeMs;
    this.cooldownMs = cooldownMs;
    this.onSelect = onSelect || null;
    this.onProgress = onProgress || null;

    this.voteN = Math.max(1, voteN | 0);
    this.switchMs = Math.max(0, switchMs);
    this.minConf = minConf;
    this.enabled = true;

    this.zone = null; // 已提交（commit）的区域
    this.dwellStart = 0;
    this.progress = 0;
    this._cooldownUntil = 0;

    this._buf = []; // 最近的 x 样本（表决用）
    this._cand = null; // 候选区 id
    this._candSince = 0;
    this._dropped = 0; // 因低置信度丢弃的帧数（诊断用）
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this.zone = null;
      this.progress = 0;
      this._buf.length = 0;
      this._cand = null;
    }
  }

  reset() {
    this.zone = null;
    this.dwellStart = 0;
    this.progress = 0;
    this._cooldownUntil = 0;
    this._buf.length = 0;
    this._cand = null;
    this._candSince = 0;
    this._dropped = 0;
  }

  zoneAt(x) {
    for (const z of this.zones) {
      if (x >= z.x0 && x < z.x1) return z;
    }
    return this.zones[this.zones.length - 1];
  }

  _zoneById(id) {
    return this.zones.find((z) => z.id === id) || null;
  }

  /** 多数表决：窗口内各帧 x 所属区投票；平票时优先维持当前区，避免来回跳 */
  _voteZone() {
    if (!this._buf.length) return null;
    const count = new Map();
    for (const x of this._buf) {
      const id = this.zoneAt(x).id;
      count.set(id, (count.get(id) || 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [id, n] of count) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    if (this.zone && count.get(this.zone.id) === bestN) return this.zone.id;
    return best;
  }

  /** 提交一个区域并重置停留计时 */
  _commit(id, now) {
    this.zone = this._zoneById(id);
    this.dwellStart = now;
    this.progress = 0;
    if (this.onProgress) this.onProgress({ id: this.zone.id, progress: 0 });
    return { zone: this.zone.id, progress: 0, fired: null };
  }

  /**
   * @param {{x:number,y:number,conf?:number}|null} cursor
   * @param {number} now
   * @returns {{zone:string|null, progress:number, fired:string|null, lowConf?:boolean}}
   */
  update(cursor, now) {
    if (!this.enabled || !cursor) {
      this.zone = null;
      this.progress = 0;
      this._buf.length = 0;
      this._cand = null;
      return { zone: null, progress: 0, fired: null };
    }

    // ---- 置信度门控：眨眼/眯眼/脸偏时不推进停留，保持当前状态
    const conf = cursor.conf == null ? 1 : cursor.conf;
    if (conf < this.minConf) {
      this._dropped++;
      this._buf.length = 0;
      this._cand = null;
      if (this.onProgress) this.onProgress({ id: this.zone ? this.zone.id : null, progress: this.progress });
      return { zone: this.zone ? this.zone.id : null, progress: this.progress, fired: null, lowConf: true };
    }

    const x = Number.isFinite(cursor.x) ? cursor.x : 0.5;
    this._buf.push(x);
    if (this._buf.length > this.voteN) this._buf.shift();

    const candId = this._voteZone();
    if (!candId) return { zone: this.zone ? this.zone.id : null, progress: this.progress, fired: null };

    if (candId !== this._cand) {
      this._cand = candId;
      this._candSince = now;
    }

    // 首次进入：立即提交，保证一进来就有反馈
    if (!this.zone) return this._commit(candId, now);

    // ---- 换区迟滞：候选区持续 switchMs 才真正切换
    if (this.zone.id !== candId) {
      if (now - this._candSince >= this.switchMs) return this._commit(candId, now);
      // 迟滞窗口内：维持原区，停留清零（不给"半路换区"累计）
      this.dwellStart = now;
      this.progress = 0;
      if (this.onProgress) this.onProgress({ id: this.zone.id, progress: 0 });
      return { zone: this.zone.id, progress: 0, fired: null };
    }

    // ---- 同一区域：累积停留
    if (now < this._cooldownUntil) {
      this.progress = Math.min(1, (now - this.dwellStart) / this.gazeMs);
      if (this.onProgress) this.onProgress({ id: this.zone.id, progress: this.progress });
      return { zone: this.zone.id, progress: this.progress, fired: null };
    }

    this.progress = Math.min(1, (now - this.dwellStart) / this.gazeMs);
    if (this.onProgress) this.onProgress({ id: this.zone.id, progress: this.progress });

    if (this.progress >= 1) {
      this._cooldownUntil = now + this.cooldownMs;
      this.dwellStart = now;
      this.progress = 0;
      if (this.onSelect) this.onSelect(this.zone.id, this.zone);
      return { zone: this.zone.id, progress: 0, fired: this.zone.id };
    }
    return { zone: this.zone.id, progress: this.progress, fired: null };
  }
}

/**
 * 三区视线巡检器（ZoneSweepTest）
 *
 * 用途：验证「注视区域」这条路到底靠不靠谱，量化而不是靠感觉。
 * 流程：按 左 → 中 → 右 循环出题（rounds 轮），每题分两个阶段：
 *   1) settle（就位）：给用户时间把视线移过去，期间不采样；
 *   2) sample（采样）：连续记录 cursor.x 与其所属区，与题目比对。
 *
 * 输出（每区）：
 *   - 命中率 correct/frames
 *   - 混淆分布 confusion{left,center,right}：看向该区时被判成了什么
 *   - 中位落点 medianX：看向该区时 x 的典型值（用于反推分区边界该放哪）
 *   - 延迟 latency：从采样开始到「连续 3 帧判对」所需毫秒数
 *   - 总命中率 overall
 *
 * 不依赖 DOM，纯逻辑类，方便在页面或 Node 里复用。
 */

export const ZONE_IDS = ['left', 'center', 'right'];

export class ZoneSweepTest {
  /**
   * @param {object} opts
   *   split    分区边界（与 GazeZoneSelector 的 GAZE_SPLIT 保持一致）
   *   rounds   每个区重复几轮（默认 3 → 共 9 题）
   *   settleMs 每题就位时间
   *   sampleMs 每题采样时长
   *   minConf  低于此置信度的帧不计入统计
   *   onEvent(type, payload)  type: 'target' | 'sample' | 'done'
   */
  constructor({ split = 0.34, rounds = 3, settleMs = 900, sampleMs = 1200, minConf = 0.22, onEvent } = {}) {
    this.split = split;
    this.rounds = Math.max(1, rounds | 0);
    this.settleMs = settleMs;
    this.sampleMs = sampleMs;
    this.minConf = minConf;
    this.onEvent = onEvent || null;

    this.running = false;
    this.plan = [];
    this.idx = -1;
    this.phase = 'idle'; // idle | settle | sample | done
    this.phaseStart = 0;
    this.resetStats();
  }

  resetStats() {
    this.stats = {};
    for (const id of ZONE_IDS) {
      this.stats[id] = {
        target: id,
        frames: 0,
        correct: 0,
        confusion: { left: 0, center: 0, right: 0 },
        xs: [],
        runLen: 0,
        latency: null,
      };
    }
    this.overallFrames = 0;
    this.overallCorrect = 0;
    this.dropped = 0;
  }

  /** x 属于哪个区（与 GazeZoneSelector 的判定完全一致） */
  zoneOf(x) {
    if (x < this.split) return 'left';
    if (x >= 1 - this.split) return 'right';
    return 'center';
  }

  get target() {
    return this.idx >= 0 && this.idx < this.plan.length ? this.plan[this.idx] : null;
  }

  start(now = performance.now()) {
    this.plan = [];
    for (let r = 0; r < this.rounds; r++) {
      for (const id of ZONE_IDS) this.plan.push(id);
    }
    this.idx = -1;
    this.running = true;
    this.phase = 'idle';
    this.resetStats();
    this._advance(now);
  }

  stop() {
    this.running = false;
    this.phase = 'idle';
  }

  _advance(now) {
    this.idx++;
    if (this.idx >= this.plan.length) {
      this.phase = 'done';
      this.running = false;
      if (this.onEvent) this.onEvent('done', this.snapshot());
      return;
    }
    this.phase = 'settle';
    this.phaseStart = now;
    if (this.onEvent) this.onEvent('target', this.target);
  }

  tick(cursor, now = performance.now()) {
    if (!this.running) return this.snapshot();
    const t = this.target;
    if (!t) return this.snapshot();

    if (this.phase === 'settle') {
      if (now - this.phaseStart >= this.settleMs) {
        this.phase = 'sample';
        this.phaseStart = now;
        if (this.onEvent) this.onEvent('sample', t);
      }
      return this.snapshot();
    }

    if (this.phase === 'sample') {
      if (cursor && Number.isFinite(cursor.x)) {
        const conf = cursor.conf == null ? 1 : cursor.conf;
        if (conf >= this.minConf) {
          const z = this.zoneOf(cursor.x);
          const s = this.stats[t];
          s.frames++;
          s.xs.push(cursor.x);
          s.confusion[z]++;
          const ok = z === t;
          if (ok) {
            s.correct++;
            s.runLen++;
            if (s.latency == null && s.runLen >= 3) s.latency = now - this.phaseStart;
          } else {
            s.runLen = 0;
          }
          this.overallFrames++;
          if (ok) this.overallCorrect++;
        } else {
          this.dropped++;
        }
      }
      if (now - this.phaseStart >= this.sampleMs) this._advance(now);
      return this.snapshot();
    }

    return this.snapshot();
  }

  /** 当前阶段的进度 0..1（用于画倒计时环） */
  phaseProgress(now = performance.now()) {
    if (this.phase === 'settle') return Math.min(1, (now - this.phaseStart) / this.settleMs);
    if (this.phase === 'sample') return Math.min(1, (now - this.phaseStart) / this.sampleMs);
    return 0;
  }

  _median(arr) {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  _pct(arr, q) {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * q))];
  }

  snapshot() {
    const rows = ZONE_IDS.map((id) => {
      const s = this.stats[id];
      return {
        id,
        frames: s.frames,
        acc: s.frames ? s.correct / s.frames : 0,
        confusion: { ...s.confusion },
        medianX: this._median(s.xs),
        latency: s.latency,
      };
    });
    return {
      running: this.running,
      phase: this.phase,
      target: this.target,
      idx: this.idx,
      total: this.plan.length,
      overall: this.overallFrames ? this.overallCorrect / this.overallFrames : 0,
      frames: this.overallFrames,
      dropped: this.dropped,
      rows,
    };
  }

  /**
   * 根据实测落点建议分区边界。
   * 左右分布若重叠，说明当前分区不可靠，先别改边界，先改善采集条件。
   */
  suggestSplit() {
    const L = this.stats.left.xs;
    const R = this.stats.right.xs;
    if (L.length < 10 || R.length < 10) return null;
    const leftP95 = this._pct(L, 0.95);
    const rightP05 = this._pct(R, 0.05);
    const overlap = !(leftP95 < rightP05);
    const mid = (leftP95 + rightP05) / 2;
    return {
      overlap,
      leftP95,
      rightP05,
      leftMedian: this._median(L),
      rightMedian: this._median(R),
      suggest: overlap ? null : Math.max(0.22, Math.min(0.44, mid)),
      current: this.split,
    };
  }
}

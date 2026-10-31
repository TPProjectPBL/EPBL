/**
 * 伪 3D 三车道跑酷引擎（游戏占位实现）
 *
 * 定位说明：本文件是「前置 UI 之后那块画面」的**占位实现** —— 足够跑通输入映射
 * （眼动变道 / 挥手跳跃 / 挥手滑铲 / 握拳护盾）、碰撞与结算，但不是最终美术与关卡。
 * 正式版本应替换渲染层，保留 `setLane / jump / slide / shield` 这组控制接口。
 *
 * 世界坐标：obstacle.t ∈ [0,1]，1 = 最远处，0 = 玩家所在平面。
 * 每帧 t 减小，t 跨过 [0, hitWindow] 时做碰撞判定。
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

export const ObstacleType = Object.freeze({
  BLOCK: 'block', // 整块护栏：只能变道躲
  LOW: 'low', // 低栏：跳过去
  HIGH: 'high', // 横杆：滑铲过
});

export class RunnerGame {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.laneCount = options.laneCount || 3;
    this.durationSec = options.durationSec ?? 60; // 0 表示无限
    this.livesMax = options.lives ?? 3;
    this.difficulty = options.difficulty || 'normal'; // easy | normal | hard
    this.autoLoop = options.autoLoop !== false;

    this.onEnd = options.onEnd || null;
    this.onEvent = options.onEvent || null; // (type, payload)：'hit' | 'jump' | 'slide' | 'shield' | 'lane'

    this.jumpMs = 620;
    this.slideMs = 520;
    this.invulnMs = 1200;
    this.shieldMs = 2600;
    this.shieldCdMs = 8000;

    this._raf = 0;
    this._lastT = 0;
    this.running = false;
    this.paused = false;

    this.reset();
    this.resize();
  }

  /* ------------------------------------------------------------ 生命周期 */

  reset() {
    this.stats = {
      score: 0,
      distance: 0, // 归一化里程
      meters: 0,
      laneChanges: 0,
      jumps: 0,
      slides: 0,
      shields: 0,
      hits: 0,
      duration: 0,
    };
    this.lane = 1;
    this.targetLane = 1;
    this.laneVisual = 1;
    this.lives = this.livesMax;
    this.timeLeft = this.durationSec || Infinity;
    this.elapsed = 0;

    this.obstacles = [];
    this.spawnTimer = 0.6;
    this.jumpUntil = 0;
    this.slideUntil = 0;
    this.invulnUntil = 0;
    this.shieldUntil = 0;
    this.shieldReadyAt = 0;
    this.hitFlash = 0;
    this.stars = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random() * 0.36, r: Math.random() * 1.6 + 0.4 }));
    this.over = false;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.W = Math.max(1, Math.round(rect.width));
    this.H = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.render(0);
  }

  start(now = performance.now()) {
    this.stop(); // 保证只有一条渲染循环（重复 start 不会加速）
    this.reset();
    this.over = false;
    this.running = true;
    this.paused = false;
    this._lastT = now;
    if (this.autoLoop) this._loop(now);
    return this;
  }

  pause() {
    this.paused = true;
  }

  resume(now = performance.now()) {
    if (!this.running || this.over) return;
    this.paused = false;
    this._lastT = now;
  }

  /**
   * 回到赛道屏时恢复渲染循环（例如从设置页返回），但保持暂停，
   * 由外层调用 resume() 决定何时真正继续。
   */
  resumeLoop(now = performance.now()) {
    if (this.over || this.running) return false;
    this.running = true;
    this.paused = true;
    this._lastT = now;
    this.render(now);
    if (this.autoLoop) this._loop(now);
    return true;
  }

  setPaused(on, now = performance.now()) {
    this.paused = !!on;
    this._lastT = now;
  }

  stop() {
    this.running = false;
    this.paused = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _loop(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, Math.max(0, (now - this._lastT) / 1000));
    this._lastT = now;
    if (!this.paused && !this.over) this.step(dt, now);
    this.render(now);
    const id = requestAnimationFrame((t) => this._loop(t));
    if (this.running) this._raf = id;
    else cancelAnimationFrame(id); // step/render 里已结算，取消这条链
  }

  /* ------------------------------------------------------------ 控制接口 */

  setLane(i, { count = true } = {}) {
    const next = clamp(Math.round(i), 0, this.laneCount - 1);
    if (next === this.targetLane) return false;
    this.targetLane = next;
    if (count) {
      this.stats.laneChanges += 1;
      this._emit('lane', { lane: next });
    }
    return true;
  }

  moveLane(dir) {
    return this.setLane(this.targetLane + (dir > 0 ? 1 : -1));
  }

  jump(now = performance.now()) {
    if (this.jumping(now) || this.over) return false;
    this.jumpUntil = now + this.jumpMs;
    this.slideUntil = 0;
    this.stats.jumps += 1;
    this._emit('jump', {});
    return true;
  }

  slide(now = performance.now()) {
    if (this.sliding(now) || this.over) return false;
    this.slideUntil = now + this.slideMs;
    this.jumpUntil = 0;
    this.stats.slides += 1;
    this._emit('slide', {});
    return true;
  }

  shield(now = performance.now()) {
    if (this.over) return false;
    if (now < this.shieldReadyAt) return false;
    this.shieldUntil = now + this.shieldMs;
    this.shieldReadyAt = now + this.shieldCdMs;
    this.stats.shields += 1;
    this._emit('shield', {});
    return true;
  }

  jumping(now = performance.now()) {
    return now < this.jumpUntil;
  }
  sliding(now = performance.now()) {
    return now < this.slideUntil;
  }
  shielded(now = performance.now()) {
    return now < this.shieldUntil;
  }

  _emit(type, payload) {
    if (this.onEvent) this.onEvent(type, payload);
  }

  /* ------------------------------------------------------------ 每帧推进 */

  step(dt, now = performance.now()) {
    this.elapsed += dt;
    if (this.durationSec > 0) {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
    }

    // 速度随里程提升；难度系数放大
    const diffK = this.difficulty === 'hard' ? 1.35 : this.difficulty === 'easy' ? 0.78 : 1;
    this.speed = (0.52 + Math.min(0.55, this.stats.distance / 900)) * diffK;
    this.stats.distance += this.speed * dt;
    this.stats.meters = Math.floor(this.stats.distance * 26);

    // 车道视觉插值（变道动画）
    this.laneVisual += (this.targetLane - this.laneVisual) * Math.min(1, dt * 12);
    if (Math.abs(this.targetLane - this.laneVisual) < 0.01) this.laneVisual = this.targetLane;
    this.lane = Math.round(this.laneVisual);

    // 生成障碍
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const gapBase = 0.95 - Math.min(0.5, this.stats.distance / 1300);
      this.spawnTimer = clamp(gapBase / diffK, 0.38, 1.2) * rand(0.85, 1.2);
      this._spawn();
    }

    // 推进障碍
    const hitWindow = 0.055;
    for (const ob of this.obstacles) {
      const prevT = ob.t;
      ob.t -= this.speed * dt;
      if (prevT > hitWindow && ob.t <= hitWindow) this._checkHit(ob, now);
    }
    this.obstacles = this.obstacles.filter((o) => o.t > -0.06);

    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.2);

    // 计分
    this.stats.score = Math.floor(this.stats.distance * 10 + this.stats.jumps * 15 + this.stats.slides * 15 + this.stats.shields * 20);

    // 结算
    if (this.stats && this.durationSec > 0 && this.timeLeft <= 0) this._finish('time');
    else if (this.lives <= 0) this._finish('lives');
  }

  _spawn() {
    const r = Math.random();
    let type = ObstacleType.BLOCK;
    const hardK = this.difficulty === 'hard' ? 0.42 : this.difficulty === 'easy' ? 0.2 : 0.3;
    if (r < hardK) type = ObstacleType.LOW;
    else if (r < hardK * 2) type = ObstacleType.HIGH;

    const lane = Math.floor(Math.random() * this.laneCount);
    this.obstacles.push({ lane, t: 1, type });
  }

  _checkHit(ob, now) {
    if (Math.abs(ob.lane - this.laneVisual) > 0.45) return; // 不同车道
    if (now < this.invulnUntil) return;

    if (this.shielded(now)) return;
    if (ob.type === ObstacleType.LOW && this.jumping(now)) return;
    if (ob.type === ObstacleType.HIGH && this.sliding(now)) return;
    if (ob.type === ObstacleType.BLOCK && this.jumping(now)) return; // 从上方跃过护栏（宽容处理）

    this.lives -= 1;
    this.stats.hits += 1;
    this.invulnUntil = now + this.invulnMs;
    this.hitFlash = 1;
    this._emit('hit', { type: ob.type, lives: this.lives });
  }

  _finish(reason) {
    if (this.over) return;
    this.over = true;
    this.running = false;
    this.stats.duration = Math.round(this.elapsed);
    if (this.onEnd) this.onEnd({ ...this.stats, reason });
  }

  /* ------------------------------------------------------------ 渲染 */

  _project(t, laneOffset) {
    const horizon = this.H * 0.34;
    const scale = 1 - t * 0.86;
    const y = horizon + (this.H - horizon) * scale;
    const x = this.W / 2 + laneOffset * this.W * 0.3 * scale;
    return { x, y, scale };
  }

  render(now = performance.now()) {
    const ctx = this.ctx;
    const { W, H } = this;
    ctx.clearRect(0, 0, W, H);

    // 天空
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#080d1c');
    sky.addColorStop(0.45, '#101a38');
    sky.addColorStop(1, '#16123a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // 星点
    ctx.fillStyle = 'rgba(190, 215, 255, 0.55)';
    for (const s of this.stars) {
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    this._drawRoad(ctx, now);
    this._drawObstacles(ctx, now);
    this._drawPlayer(ctx, now);

    if (this.hitFlash > 0) {
      ctx.fillStyle = `rgba(240, 90, 120, ${0.28 * this.hitFlash})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (this.shielded(now)) {
      ctx.strokeStyle = 'rgba(80, 220, 200, 0.7)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(W / 2 + (this.laneVisual - 1) * W * 0.3, H * 0.78, W * 0.11, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawRoad(ctx, now) {
    const { W, H } = this;
    const horizon = H * 0.34;

    // 路面
    const road = ctx.createLinearGradient(0, horizon, 0, H);
    road.addColorStop(0, 'rgba(35, 50, 95, 0.35)');
    road.addColorStop(1, 'rgba(28, 42, 88, 0.95)');
    ctx.fillStyle = road;
    const nearHalf = W * 0.42;
    const farHalf = W * 0.42 * 0.14;
    ctx.beginPath();
    ctx.moveTo(W / 2 - farHalf, horizon);
    ctx.lineTo(W / 2 + farHalf, horizon);
    ctx.lineTo(W / 2 + nearHalf, H);
    ctx.lineTo(W / 2 - nearHalf, H);
    ctx.closePath();
    ctx.fill();

    // 双侧霓虹护栏
    for (const side of [-1, 1]) {
      const g = ctx.createLinearGradient(0, horizon, 0, H);
      g.addColorStop(0, 'rgba(80, 170, 255, 0.15)');
      g.addColorStop(1, 'rgba(122, 59, 255, 0.95)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(W / 2 + side * farHalf, horizon);
      ctx.lineTo(W / 2 + side * nearHalf, H);
      ctx.stroke();
    }

    // 车道虚线（随里程滚动）
    const phase = (this.stats.distance * 3) % 1;
    for (let i = 1; i < this.laneCount; i++) {
      const off = (i - this.laneCount / 2) * 2 * 0.5; // -1, 1
      for (let k = 0; k < 8; k++) {
        const t0 = k / 8 + phase / 8;
        const t1 = t0 + 0.045;
        if (t1 > 1) continue;
        const a = this._project(1 - t0, off);
        const b = this._project(1 - Math.min(1, t1), off);
        ctx.strokeStyle = 'rgba(150, 185, 255, 0.35)';
        ctx.lineWidth = Math.max(1, 3 * b.scale);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  _drawObstacles(ctx, now) {
    for (const ob of this.obstacles) {
      const off = ob.lane - (this.laneCount - 1) / 2; // -1 / 0 / +1
      const p = this._project(ob.t, off);
      const w = this.W * 0.15 * p.scale;
      const h = this.H * 0.2 * p.scale;
      const alpha = clamp(1.2 - ob.t, 0.25, 1);

      ctx.save();
      ctx.globalAlpha = alpha;

      if (ob.type === ObstacleType.BLOCK) {
        ctx.fillStyle = '#3a4a7a';
        this._roundRect(ctx, p.x - w / 2, p.y - h, w, h, 4 * p.scale);
        ctx.fill();
        ctx.strokeStyle = '#ff8fa3';
        ctx.lineWidth = Math.max(1, 2.4 * p.scale);
        ctx.stroke();
      } else if (ob.type === ObstacleType.LOW) {
        ctx.fillStyle = '#f0c674';
        this._roundRect(ctx, p.x - w / 2, p.y - h * 0.32, w, h * 0.32, 3 * p.scale);
        ctx.fill();
      } else {
        ctx.fillStyle = '#50aaff';
        this._roundRect(ctx, p.x - w / 2, p.y - h * 1.15, w, h * 0.3, 3 * p.scale);
        ctx.fill();
        ctx.strokeStyle = 'rgba(80, 170, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - w / 2, p.y - h * 0.85);
        ctx.lineTo(p.x - w / 2, p.y);
        ctx.moveTo(p.x + w / 2, p.y - h * 0.85);
        ctx.lineTo(p.x + w / 2, p.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawPlayer(ctx, now) {
    const { W, H } = this;
    const off = this.laneVisual - (this.laneCount - 1) / 2;
    const baseY = H * 0.9;
    const x = W / 2 + off * W * 0.3;

    let y = baseY;
    let squash = 1;
    if (this.jumping(now)) {
      const k = 1 - (this.jumpUntil - now) / this.jumpMs; // 0→1
      y = baseY - Math.sin(Math.PI * k) * H * 0.17;
    } else if (this.sliding(now)) {
      squash = 0.45;
      y = baseY + H * 0.02;
    }

    const w = W * 0.07;
    const h = H * 0.075 * squash;

    // 拖影
    const trail = ctx.createLinearGradient(x, y - h * 3, x, y);
    trail.addColorStop(0, 'rgba(122, 59, 255, 0)');
    trail.addColorStop(1, 'rgba(122, 59, 255, 0.35)');
    ctx.fillStyle = trail;
    ctx.fillRect(x - w * 0.35, y - h * 3, w * 0.7, h * 3);

    // 本体
    const body = ctx.createLinearGradient(x - w / 2, y - h, x + w / 2, y);
    body.addColorStop(0, '#2f6bff');
    body.addColorStop(1, '#7a3bff');
    ctx.fillStyle = body;
    this._roundRect(ctx, x - w / 2, y - h, w, h, 6);
    ctx.fill();

    // 护盾光效
    if (this.shielded(now)) {
      ctx.strokeStyle = 'rgba(160, 255, 235, 0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y - h * 0.6, Math.max(w, h) * 0.95, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 无敌闪烁
    if (now < this.invulnUntil && Math.floor(now / 90) % 2 === 0) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      this._roundRect(ctx, x - w / 2, y - h, w, h, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /** HUD 用快照 */
  snapshot(now = performance.now()) {
    return {
      score: this.stats.score,
      meters: this.stats.meters,
      lives: this.lives,
      timeLeft: this.durationSec > 0 ? this.timeLeft : null,
      lane: this.targetLane,
      shielded: this.shielded(now),
      shieldReady: now >= this.shieldReadyAt,
      jumping: this.jumping(now),
      sliding: this.sliding(now),
      over: this.over,
    };
  }
}

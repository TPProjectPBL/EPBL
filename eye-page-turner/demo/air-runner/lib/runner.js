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

    // 与首页背景同一张图：把它做成上下镜像的竖向无缝贴片，滚动时不出现接缝
    this.waterReady = false;
    this.waterTile = null;
    this.water = new Image();
    this.water.onload = () => this._buildWaterTile(this.water);
    // 相对模块自身定位，不依赖页面 URL 层级
    this.water.src = new URL('../assets/river-soft.jpg', import.meta.url).href;

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
    this.speed = (0.5 + Math.min(0.42, this.stats.distance / 1100)) * diffK;
    this.stats.distance += this.speed * dt;
    this.stats.meters = Math.floor(this.stats.distance * 26);

    // 车道视觉插值（变道动画）
    this.laneVisual += (this.targetLane - this.laneVisual) * Math.min(1, dt * 12);
    if (Math.abs(this.targetLane - this.laneVisual) < 0.01) this.laneVisual = this.targetLane;
    this.lane = Math.round(this.laneVisual);

    // 生成障碍：基础间隔拉长，并设下限，避免连续贴脸
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const gapBase = 1.55 - Math.min(0.5, this.stats.distance / 1600);
      this.spawnTimer = clamp(gapBase / diffK, 0.85, 1.9) * rand(0.95, 1.15);
      this._spawn();
    }

    // 推进障碍（0.12 让判定点落在玩家脚下，视觉与手感一致）
    const hitWindow = 0.12;
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
    // 最小间距：上一个障碍还没走远就不再生成，避免两连发
    if (this.obstacles.some((o) => o.t > 0.80)) {
      this.spawnTimer = 0.22;
      return;
    }

    const r = Math.random();
    let type = ObstacleType.BLOCK;
    const hardK = this.difficulty === 'hard' ? 0.42 : this.difficulty === 'easy' ? 0.2 : 0.3;
    if (r < hardK) type = ObstacleType.LOW;
    else if (r < hardK * 2) type = ObstacleType.HIGH;

    // 通路保护：同批障碍里若已有 laneCount-1 条被占，只允许生成在剩余车道，
    // 避免出现「三条车道同时堵死」的必死组合。
    const used = new Set(this.obstacles.filter((o) => o.t > 0.82).map((o) => o.lane));
    let lane = Math.floor(Math.random() * this.laneCount);
    if (used.size >= this.laneCount - 1) {
      const free = [];
      for (let i = 0; i < this.laneCount; i++) if (!used.has(i)) free.push(i);
      if (!free.length) return;
      lane = free[Math.floor(Math.random() * free.length)];
    }

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
    const depth = 1 - t; // 0 = 最远, 1 = 玩家平面
    const scale = 0.10 + 0.90 * depth;
    const y = horizon + (this.H - horizon) * depth;
    const x = this.W / 2 + laneOffset * this.W * 0.30 * scale;
    return { x, y, scale };
  }

  render(now = performance.now()) {
    const ctx = this.ctx;
    const { W, H } = this;
    ctx.clearRect(0, 0, W, H);

    // 天空
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#06120f');
    sky.addColorStop(0.45, '#0c211c');
    sky.addColorStop(1, '#0f2f27');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // 萤火点（原星点，压暗以符合河谷夜色）
    ctx.fillStyle = 'rgba(190, 240, 214, 0.20)';
    for (const s of this.stars) {
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H * 0.9, s.r * 0.85, 0, Math.PI * 2);
      ctx.fill();
    }

    const horizon = H * 0.34;

    // 两层河谷山脊，极慢视差
    const drift = this.stats.distance * 0.012;
    const ridge = (baseY, amp, freq, phase, color) => {
      ctx.beginPath();
      ctx.moveTo(-2, baseY);
      for (let x = 0; x <= W + 2; x += W / 26) {
        const k = x / W;
        const y =
          baseY -
          (amp + Math.sin(k * freq + phase) * amp * 0.55 + Math.sin(k * freq * 2.7 + phase * 1.7) * amp * 0.22) * H;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W + 2, baseY);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    ridge(horizon + 1, 0.072, 5.2, drift * 0.6, '#061b17');
    ridge(horizon + 1, 0.1, 3.1, drift * 0.9 + 1.7, '#0a2620');

    // 谷底雾带，柔化地平线
    const mist = ctx.createLinearGradient(0, horizon - H * 0.06, 0, horizon + H * 0.10);
    mist.addColorStop(0, 'rgba(138, 214, 184, 0)');
    mist.addColorStop(0.42, 'rgba(138, 214, 184, 0.07)');
    mist.addColorStop(1, 'rgba(138, 214, 184, 0)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, horizon - H * 0.06, W, H * 0.16);

    this._drawRoad(ctx, now);
    this._drawObstacles(ctx, now);
    this._drawPlayer(ctx, now);

    if (this.hitFlash > 0) {
      ctx.fillStyle = `rgba(240, 90, 120, ${0.28 * this.hitFlash})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  _drawRoad(ctx, now) {
    const { W, H } = this;
    const horizon = H * 0.34;
    const nearHalf = W * 0.375;
    const scaleAt = (t) => 0.10 + 0.90 * (1 - t);
    const yAt = (t) => horizon + (H - horizon) * (1 - t);
    const halfAt = (t) => nearHalf * scaleAt(t);

    // 河岸底色：两侧压暗，让河面成为唯一亮面
    const bank = ctx.createLinearGradient(0, horizon, 0, H);
    bank.addColorStop(0, 'rgba(19, 42, 31, 0)');
    bank.addColorStop(1, 'rgba(14, 32, 23, 0.95)');
    ctx.fillStyle = bank;
    ctx.fillRect(0, horizon, W, H - horizon);

    // 河道水面：贴首页那张河流图，用透视切片滚动做出流动感
    this._waterPath(ctx, halfAt, horizon);
    ctx.save();
    ctx.clip();
    this._paintWaterTexture(ctx, horizon, nearHalf, now);
    ctx.restore();

    // 水面反光
    const sheen = ctx.createLinearGradient(0, horizon, 0, H);
    sheen.addColorStop(0, 'rgba(140, 232, 214, 0)');
    sheen.addColorStop(0.6, 'rgba(140, 232, 214, 0.06)');
    sheen.addColorStop(1, 'rgba(140, 232, 214, 0.15)');
    ctx.fillStyle = sheen;
    this._waterPath(ctx, halfAt, horizon);
    ctx.fill();

    // 横向水波：随里程向近处滚动，用二次曲线做出轻微起伏
    const flow = (this.stats.distance * 5) % 1;
    for (let k = 0; k < 16; k++) {
      const t = 1 - (k + flow) / 16;
      if (t < 0.02 || t > 0.995) continue;
      const s = scaleAt(t);
      const y = yAt(t);
      const half = halfAt(t);
      const wob = Math.sin(this.stats.distance * 1.7 + k * 0.9) * H * 0.005 * s;
      ctx.strokeStyle = `rgba(150, 226, 208, ${0.008 + 0.032 * s})`;
      ctx.lineWidth = Math.max(0.6, 1.7 * s);
      ctx.beginPath();
      ctx.moveTo(W / 2 - half * 0.97, y);
      ctx.quadraticCurveTo(W / 2, y + wob, W / 2 + half * 0.97, y);
      ctx.stroke();
    }

    // 航道浮标：替代车道虚线，暖黄浮球串起三条水道
    const dashPhase = (this.stats.distance * 2.4) % 1;
    for (let i = 1; i < this.laneCount; i++) {
      const off = (i - this.laneCount / 2) * 1; // 3 车道 → ±0.5
      for (let k = 0; k < 11; k++) {
        const t = 1 - (k + dashPhase) / 11;
        if (t < 0.03 || t > 0.99) continue;
        const p = this._project(t, off);
        const r = Math.max(0.7, 3.1 * p.scale);
        // 水面倒影
        ctx.fillStyle = `rgba(255, 228, 168, ${0.08 + 0.10 * p.scale})`;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + r * 1.5, r * 1.9, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        // 浮球
        ctx.fillStyle = `rgba(255, 208, 116, ${0.22 + 0.52 * p.scale})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 246, 214, ${0.20 + 0.45 * p.scale})`;
        ctx.beginPath();
        ctx.arc(p.x - r * 0.28, p.y - r * 0.30, r * 0.40, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 双侧河岸木桩：桩身 + 顶端暖灯 + 岸线
    for (const side of [-1, 1]) {
      for (let k = 0; k < 11; k++) {
        const t = 1 - (k + flow) / 11;
        if (t < 0.02 || t > 0.99) continue;
        const s = scaleAt(t);
        const x = W / 2 + side * halfAt(t);
        const y = yAt(t);
        const postH = H * 0.055 * s;
        ctx.strokeStyle = `rgba(190, 148, 100, ${0.12 + 0.42 * s})`;
        ctx.lineWidth = Math.max(1, 2.6 * s);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - postH);
        ctx.stroke();
        // 顶端灯点
        ctx.fillStyle = `rgba(255, 214, 150, ${0.18 + 0.50 * s})`;
        ctx.beginPath();
        ctx.arc(x, y - postH, Math.max(0.8, 2.2 * s), 0, Math.PI * 2);
        ctx.fill();
      }

      const g = ctx.createLinearGradient(0, horizon, 0, H);
      g.addColorStop(0, 'rgba(196, 158, 110, 0.05)');
      g.addColorStop(1, 'rgba(206, 170, 122, 0.34)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(W / 2 + side * halfAt(1), horizon);
      ctx.lineTo(W / 2 + side * halfAt(0), H);
      ctx.stroke();
    }

    // 水面碎光：随里程向近处漂移
    for (let k = 0; k < 26; k++) {
      const t = 1 - ((k * 0.618 + this.stats.distance * 0.9) % 1);
      if (t < 0.05 || t > 0.97) continue;
      const s = scaleAt(t);
      const y = yAt(t);
      const laneOff = ((k % 7) - 3) * 0.22;
      const x = W / 2 + laneOff * W * 0.3 * s + Math.sin(k * 2.3) * W * 0.015 * s;
      const r = Math.max(0.6, 2.4 * s);
      ctx.fillStyle = `rgba(196, 246, 236, ${0.04 + 0.14 * s})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 2.4, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 水面涟漪：缓慢扩散的椭圆光弧
    for (let k = 0; k < 4; k++) {
      const t = 1 - ((k * 0.26 + this.stats.distance * 0.55) % 1);
      if (t < 0.14 || t > 0.94) continue;
      const s = scaleAt(t);
      const y = yAt(t);
      const half = halfAt(t);
      const cx = W / 2 + Math.sin(k * 2.1 + this.stats.distance * 0.4) * half * 0.22;
      const a0 = Math.PI + k * 0.5;
      ctx.strokeStyle = `rgba(176, 240, 220, ${0.02 + 0.035 * s})`;
      ctx.lineWidth = Math.max(0.8, 2.6 * s);
      ctx.beginPath();
      ctx.ellipse(cx, y, half * (0.42 + (k % 3) * 0.1), Math.max(1.2, H * 0.008 * s), 0, a0, a0 + Math.PI * 0.72);
      ctx.stroke();
    }

    // 漂浮落叶：随水流向近处漂，带自转
    for (let k = 0; k < 12; k++) {
      const t = 1 - ((k * 0.37 + this.stats.distance * 1.3) % 1);
      if (t < 0.06 || t > 0.94) continue;
      const s = scaleAt(t);
      const y = yAt(t);
      const half = halfAt(t);
      const x = W / 2 + ((((k * 53) % 100) / 100 - 0.5) * half * 1.3);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(k * 1.7 + this.stats.distance * 0.6);
      ctx.fillStyle = `rgba(198, 170, 100, ${0.12 + 0.32 * s})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(1, 5 * s), Math.max(0.6, 2.2 * s), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 河岸草丛：贴边生长，随里程滚动
    const bankPhase = (this.stats.distance * 3.4) % 1;
    for (const side of [-1, 1]) {
      for (let k = 0; k < 13; k++) {
        const t = 1 - (k + bankPhase) / 13;
        if (t < 0.03 || t > 0.98) continue;
        const s = scaleAt(t);
        const y = yAt(t);
        const edge = W / 2 + side * halfAt(t);
        const baseX = edge + side * W * 0.035 * s;
        const gh = H * 0.06 * s;
        const cw = W * 0.006 * s;
        ctx.strokeStyle = `rgba(96, 162, 116, ${0.1 + 0.38 * s})`;
        ctx.lineWidth = Math.max(0.8, 2 * s);
        for (let b = 0; b < 3; b++) {
          const bx = baseX + (b - 1) * cw * 2.4;
          const lean = (b - 1) * cw * 3 + Math.sin(k * 1.7 + b) * cw;
          ctx.beginPath();
          ctx.moveTo(bx, y);
          ctx.quadraticCurveTo(bx + lean * 0.4, y - gh * 0.6, bx + lean, y - gh);
          ctx.stroke();
        }
        // 芦苇穗
        ctx.fillStyle = `rgba(152, 186, 122, ${0.1 + 0.3 * s})`;
        ctx.beginPath();
        ctx.ellipse(
          baseX + Math.sin(k * 1.7) * cw,
          y - gh * 0.98,
          Math.max(0.7, 1.8 * s),
          Math.max(1.1, 3.6 * s),
          0.28,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    // 岸边石块：贴岸分布，压实河岸
    for (const side of [-1, 1]) {
      for (let k = 0; k < 9; k++) {
        const t = 1 - ((k * 0.83 + this.stats.distance * 2.6) % 1);
        if (t < 0.06 || t > 0.95) continue;
        const s = scaleAt(t);
        const y = yAt(t);
        const edge = W / 2 + side * halfAt(t);
        const cx = edge + side * W * (0.018 + ((k * 7) % 5) * 0.006) * s;
        ctx.fillStyle = `rgba(96, 110, 102, ${0.18 + 0.38 * s})`;
        ctx.beginPath();
        ctx.ellipse(cx, y, W * 0.016 * s, W * 0.006 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(94, 150, 106, ${0.1 + 0.24 * s})`;
        ctx.beginPath();
        ctx.ellipse(cx, y - W * 0.002 * s, W * 0.01 * s, W * 0.003 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 远端雾化：路面在地平线处淡入，避免生硬的梯形收口
    const fade = ctx.createLinearGradient(0, horizon, 0, horizon + H * 0.11);
    fade.addColorStop(0, 'rgba(11, 31, 26, 0.96)');
    fade.addColorStop(1, 'rgba(11, 31, 26, 0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, horizon, W, H * 0.11);
  }

  /** 河道水面的梯形路径（与 _project 的 scale、halfAt 完全同源） */
  _waterPath(ctx, halfAt, horizon) {
    const { W, H } = this;
    ctx.beginPath();
    ctx.moveTo(W / 2 - halfAt(1), horizon);
    ctx.lineTo(W / 2 + halfAt(1), horizon);
    ctx.lineTo(W / 2 + halfAt(0), H);
    ctx.lineTo(W / 2 - halfAt(0), H);
    ctx.closePath();
  }

  /** 把河流图做成上下镜像的竖向无缝贴片，循环滚动时不会出现接缝 */
  _buildWaterTile(img) {
    const w = 840;
    const h = Math.round((w * img.naturalHeight) / img.naturalWidth) || 525;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h * 2;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    g.save();
    g.translate(0, h * 2);
    g.scale(1, -1);
    g.drawImage(img, 0, 0, w, h);
    g.restore();
    this.waterTile = c;
    this.waterReady = true;
  }

  /**
   * 透视贴图：按屏幕高度切成若干条水平切片，
   * 越靠下切片越宽（河道近宽远窄），采样步长用 u^1.55 压缩远端，
   * 于是纹理在自己向上滚动时，近处明显更快 —— 看起来就是水往镜头方向流。
   */
  _paintWaterTexture(ctx, horizon, nearHalf, now) {
    const { W, H } = this;
    const span = H - horizon;

    if (!this.waterReady) {
      const water = ctx.createLinearGradient(0, horizon, 0, H);
      water.addColorStop(0, 'rgba(24, 86, 78, 0.6)');
      water.addColorStop(0.45, 'rgba(12, 64, 60, 0.91)');
      water.addColorStop(1, 'rgba(5, 34, 33, 0.99)');
      ctx.fillStyle = water;
      ctx.fillRect(0, horizon, W, span);
      return;
    }

    const tile = this.waterTile;
    const tw = tile.width;
    const th = tile.height; // 上下镜像贴片，高度 = 2 张图
    const half = th / 2;
    const srcH = half * 0.12;
    const cropW = tw * 0.7;            // 只取中间 70%，避免两侧岸线被拉成竖条
    const cropX = (tw - cropW) / 2;
    const N = 72;
    const flow = (this.stats.distance * 0.40) % 2; // 里程驱动；镜像贴片让 2 的整数倍处无缝
    const bob = Math.sin(now * 0.0011) * 0.02;     // 整体缓慢左右晃，水才有"活"感

    for (let i = 0; i < N; i++) {
      const u0 = i / N;
      const u1 = (i + 1) / N;
      const y0 = horizon + span * u0;
      const y1 = horizon + span * u1;
      const half0 = nearHalf * (0.1 + 0.9 * u0);
      const half1 = nearHalf * (0.1 + 0.9 * u1);
      const w = Math.max(half0, half1) * 2;
      let sy = ((flow + Math.pow(u0, 1.7) * 2.0) % 2) * half;
      sy = Math.max(0, Math.min(sy, th - srcH));
      // 每一层横向轻微错位：打散竖向拉伸出来的条纹
      const shift = (Math.sin(u0 * 11 + now * 0.0016) * 0.018 + bob) * cropW;
      ctx.drawImage(
        tile,
        cropX + shift, sy, cropW, srcH,
        W / 2 - w / 2, y0, w, y1 - y0 + 1.2,
      );
    }

    // 夜色统一：压到与场景一致的青绿低亮度
    ctx.fillStyle = 'rgba(7, 34, 31, 0.38)';
    ctx.fillRect(0, horizon, W, span);
    // 远端雾化：地平线附近柔化，避免贴图起始处出现硬边
    const fade = ctx.createLinearGradient(0, horizon, 0, horizon + span * 0.34);
    fade.addColorStop(0, 'rgba(9, 32, 28, 0.92)');
    fade.addColorStop(0.55, 'rgba(9, 32, 28, 0.42)');
    fade.addColorStop(1, 'rgba(9, 32, 28, 0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, horizon, W, span * 0.34);
  }

  _drawObstacles(ctx, now) {
    for (const ob of this.obstacles) {
      const off = ob.lane - (this.laneCount - 1) / 2; // -1 / 0 / +1
      const p = this._project(ob.t, off);
      const w = this.W * 0.19 * p.scale;
      const h = this.H * 0.235 * p.scale;
      const alpha = clamp(1.45 - 1.1 * ob.t, 0.36, 1);

      ctx.save();
      ctx.globalAlpha = alpha;

      // 水面接触阴影：让石头和木头"落"在河面上
      ctx.fillStyle = 'rgba(2, 14, 16, 0.42)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, w * 0.58, w * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();

      if (ob.type === ObstacleType.BLOCK) {
        // 河中巨石：必须变道
        const bw = w * 0.94;
        const bh = h * 0.80;
        ctx.beginPath();
        ctx.moveTo(p.x - bw * 0.5, p.y);
        ctx.lineTo(p.x - bw * 0.44, p.y - bh * 0.52);
        ctx.lineTo(p.x - bw * 0.18, p.y - bh * 0.94);
        ctx.lineTo(p.x + bw * 0.16, p.y - bh * 1.0);
        ctx.lineTo(p.x + bw * 0.46, p.y - bh * 0.58);
        ctx.lineTo(p.x + bw * 0.5, p.y);
        ctx.closePath();
        const rock = ctx.createLinearGradient(p.x, p.y - bh, p.x, p.y);
        rock.addColorStop(0, '#7d8b83');
        rock.addColorStop(0.55, '#5c6a63');
        rock.addColorStop(1, '#3c4a45');
        ctx.fillStyle = rock;
        ctx.fill();
        // 顶部受光棱
        ctx.strokeStyle = 'rgba(198, 226, 214, 0.45)';
        ctx.lineWidth = Math.max(1, 2 * p.scale);
        ctx.beginPath();
        ctx.moveTo(p.x - bw * 0.18, p.y - bh * 0.94);
        ctx.lineTo(p.x + bw * 0.16, p.y - bh * 1.0);
        ctx.stroke();
        // 苔藓
        ctx.fillStyle = 'rgba(94, 160, 106, 0.5)';
        ctx.beginPath();
        ctx.ellipse(p.x - bw * 0.1, p.y - bh * 0.86, bw * 0.2, bh * 0.09, -0.3, 0, Math.PI * 2);
        ctx.fill();
      } else if (ob.type === ObstacleType.LOW) {
        // 横在河面的倒木：跳过去
        const lh = h * 0.34;
        const wood = ctx.createLinearGradient(0, p.y - lh, 0, p.y);
        wood.addColorStop(0, '#a5764c');
        wood.addColorStop(0.55, '#7a5236');
        wood.addColorStop(1, '#4e3423');
        ctx.fillStyle = wood;
        this._roundRect(ctx, p.x - w / 2, p.y - lh, w, lh, lh * 0.42);
        ctx.fill();
        // 端面年轮
        ctx.fillStyle = '#c09468';
        ctx.beginPath();
        ctx.ellipse(p.x - w / 2 + lh * 0.34, p.y - lh / 2, lh * 0.22, lh * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(122, 82, 54, 0.85)';
        ctx.lineWidth = Math.max(0.6, 1.2 * p.scale);
        ctx.beginPath();
        ctx.ellipse(p.x - w / 2 + lh * 0.34, p.y - lh / 2, lh * 0.11, lh * 0.18, 0, 0, Math.PI * 2);
        ctx.stroke();
        // 苔藓
        ctx.fillStyle = 'rgba(99, 168, 110, 0.6)';
        this._roundRect(ctx, p.x - w * 0.36, p.y - lh, w * 0.56, Math.max(1.2, lh * 0.26), 2 * p.scale);
        ctx.fill();
      } else {
        // 低垂树枝：滑铲通过
        const barY = p.y - h * 1.12;
        const barH = Math.max(1.6, h * 0.2);
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#7a5236';
        ctx.lineWidth = Math.max(2, 7 * p.scale);
        ctx.beginPath();
        ctx.moveTo(p.x - w * 0.54, barY - barH * 0.5);
        ctx.quadraticCurveTo(p.x, barY + barH * 0.85, p.x + w * 0.54, barY - barH * 0.4);
        ctx.stroke();
        // 叶簇
        ctx.fillStyle = 'rgba(104, 196, 122, 0.88)';
        for (const [dx, dy, rx, ry] of [
          [-0.3, 0.18, 0.17, 0.1],
          [-0.06, 0.3, 0.18, 0.11],
          [0.2, 0.2, 0.16, 0.1],
          [0.42, 0.06, 0.11, 0.08],
          [-0.42, 0.04, 0.1, 0.07],
        ]) {
          ctx.beginPath();
          ctx.ellipse(p.x + dx * w, barY + dy * barH * 2.2, rx * w, ry * h, 0.2, 0, Math.PI * 2);
          ctx.fill();
        }
        // 两侧垂藤
        ctx.strokeStyle = 'rgba(104, 196, 122, 0.5)';
        ctx.lineWidth = Math.max(0.8, 1.6 * p.scale);
        for (const sx of [-0.46, -0.2, 0.46]) {
          ctx.beginPath();
          ctx.moveTo(p.x + sx * w, barY + barH * 0.2);
          ctx.lineTo(p.x + sx * w * 1.06, barY + h * (sx === -0.2 ? 0.46 : 0.3));
          ctx.stroke();
        }
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

    const w = W * 0.085;
    const h = H * 0.05 * squash;

    // 船尾水痕
    const trail = ctx.createLinearGradient(x, y - h * 2.4, x, y);
    trail.addColorStop(0, 'rgba(182, 246, 231, 0)');
    trail.addColorStop(1, 'rgba(182, 246, 231, 0.2)');
    ctx.fillStyle = trail;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.2, y - h * 2.4);
    ctx.lineTo(x + w * 0.2, y - h * 2.4);
    ctx.lineTo(x + w * 0.42, y);
    ctx.lineTo(x - w * 0.42, y);
    ctx.closePath();
    ctx.fill();

    // 小舟船体：尖头圆尾
    const hull = ctx.createLinearGradient(x, y - h * 1.9, x, y + h * 0.3);
    hull.addColorStop(0, '#a8f5da');
    hull.addColorStop(0.5, '#4fc9a6');
    hull.addColorStop(1, '#22836b');
    ctx.beginPath();
    ctx.moveTo(x, y - h * 1.9);
    ctx.bezierCurveTo(x + w * 0.28, y - h * 1.5, x + w * 0.5, y - h * 0.7, x + w * 0.46, y - h * 0.1);
    ctx.quadraticCurveTo(x + w * 0.4, y + h * 0.28, x, y + h * 0.3);
    ctx.quadraticCurveTo(x - w * 0.4, y + h * 0.28, x - w * 0.46, y - h * 0.1);
    ctx.bezierCurveTo(x - w * 0.5, y - h * 0.7, x - w * 0.28, y - h * 1.5, x, y - h * 1.9);
    ctx.closePath();
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.strokeStyle = 'rgba(196, 255, 240, 0.55)';
    ctx.lineWidth = Math.max(1, 1.8);
    ctx.stroke();

    // 内舱：船沿亮、舱内暗，形状才立得住
    ctx.fillStyle = 'rgba(9, 46, 39, 0.5)';
    ctx.beginPath();
    ctx.ellipse(x, y - h * 0.72, w * 0.2, h * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // 尾部水花（跳跃时收起）
    if (!this.jumping(now)) {
      ctx.fillStyle = 'rgba(214, 250, 240, 0.3)';
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(x + sx * w * 0.44, y + h * 0.3, w * 0.17, h * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 护盾光效
    if (this.shielded(now)) {
      ctx.strokeStyle = 'rgba(160, 255, 235, 0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y - h * 0.55, w * 0.92, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 无敌闪烁
    if (now < this.invulnUntil && Math.floor(now / 90) % 2 === 0) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(x, y - h * 0.5, w * 0.42, h * 1.1, 0, 0, Math.PI * 2);
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

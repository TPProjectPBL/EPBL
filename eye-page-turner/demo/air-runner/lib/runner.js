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

    // 玩家船头：从实拍照抠出、压暗成夜色的精灵图
    this.bow = new Image();
    this.bow.src = new URL('../assets/bow-night.png', import.meta.url).href;

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

    // 天空：白天的薄云与散射光
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#040d0b');
    sky.addColorStop(0.14, '#071613');
    sky.addColorStop(0.3, '#0b211b');
    sky.addColorStop(1, '#0c2820');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    const horizon = H * 0.34;

    // 云：几团亮云压在远山上空
    for (let i = 0; i < 5; i++) {
      const cx = (((i * 0.31 + 0.12) % 1) * 1.1 - 0.05) * W;
      const cy = H * (0.03 + (i % 3) * 0.045);
      const rw = W * (0.16 + (i % 4) * 0.05);
      const rh = rw * 0.16;
      const cg = ctx.createRadialGradient(cx, cy, rh * 0.2, cx, cy, rw);
      cg.addColorStop(0, 'rgba(198, 240, 228, 0.11)');
      cg.addColorStop(0.55, 'rgba(198, 240, 228, 0.045)');
      cg.addColorStop(1, 'rgba(198, 240, 228, 0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 云隙光：右上斜向左下，screen 叠加避免发灰
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 3; i++) {
      const bx = W * (0.55 + i * 0.11);
      const bw = W * 0.045;
      const g = ctx.createLinearGradient(bx, 0, bx - W * 0.42, H * 0.62);
      g.addColorStop(0, 'rgba(158, 232, 208, 0.045)');
      g.addColorStop(1, 'rgba(158, 232, 208, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(bx - bw, 0);
      ctx.lineTo(bx + bw, 0);
      ctx.lineTo(bx - W * 0.36 + bw * 1.6, H * 0.6);
      ctx.lineTo(bx - W * 0.36 - bw * 1.6, H * 0.6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 三层山脊：越远越淡，形成大气透视
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
    ridge(horizon + 1, 0.115, 4.1, drift * 0.45, 'rgba(5, 17, 16, 0.5)');
    ridge(horizon + 1, 0.092, 5.6, drift * 0.6 + 2.4, 'rgba(4, 15, 14, 0.62)');
    ridge(horizon + 1, 0.068, 6.4, drift * 0.78 + 2.2, 'rgba(3, 12, 11, 0.74)');
    ridge(horizon + 1, 0.044, 3.2, drift * 0.9 + 1.7, 'rgba(2, 8, 7, 0.88)');

    // 谷底雾带：白天的水汽更亮
    const mist = ctx.createLinearGradient(0, horizon - H * 0.05, 0, horizon + H * 0.06);
    mist.addColorStop(0, 'rgba(150, 216, 196, 0)');
    mist.addColorStop(0.45, 'rgba(150, 216, 196, 0.035)');
    mist.addColorStop(1, 'rgba(150, 216, 196, 0)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, horizon - H * 0.05, W, H * 0.11);

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
    bank.addColorStop(0, 'rgba(16, 40, 28, 0)');
    bank.addColorStop(1, 'rgba(7, 24, 17, 0.95)');
    ctx.fillStyle = bank;
    ctx.fillRect(0, horizon, W, H - horizon);

    // ── 两侧坡地：河岸抬升成山坡，靠画面外侧压暗 ──
    for (const side of [-1, 1]) {
      const inner = [];
      for (let i = 0; i <= 22; i++) {
        const t = i / 22;
        inner.push([W / 2 + side * halfAt(t), yAt(t), scaleAt(t), t]);
      }
      ctx.beginPath();
      ctx.moveTo(inner[0][0], inner[0][1]);
      for (const [x, y] of inner) ctx.lineTo(x, y);
      // 由近及远退回外侧轮廓：先横向外扩，再往上抬，坡面才立得起来
      for (let i = inner.length - 1; i >= 0; i--) {
        const [x, y, s, t] = inner[i];
        ctx.lineTo(
          x + side * W * (0.05 + 0.3 * s) * (1 + 0.34 * Math.sin(t * 3.4 + side * 1.9) + 0.12 * Math.sin(t * 8.1 + side)),
          y - H * (0.02 + 0.10 * s)
        );
      }
      ctx.closePath();
      const slope = ctx.createLinearGradient(0, horizon, 0, H);
      slope.addColorStop(0, 'rgba(9, 26, 18, 0.9)');
      slope.addColorStop(0.14, 'rgba(18, 50, 33, 0.95)');
      slope.addColorStop(0.5, 'rgba(13, 38, 25, 0.985)');
      slope.addColorStop(1, 'rgba(4, 14, 10, 1)');
      ctx.fillStyle = slope;
      ctx.fill();

      // 坡面草皮斑块：打破纯色块，读起来才像植被覆盖的山坡
      for (let k = 0; k < 7; k++) {
        const t = 0.16 + (k / 7) * 0.78;
        const s = scaleAt(t);
        ctx.fillStyle = `rgba(24, 58, 38, ${0.13 + 0.13 * s})`;
        ctx.beginPath();
        ctx.ellipse(
          W / 2 + side * (halfAt(t) + W * (0.02 + (((k * 31) % 7) / 7) * 0.08) * s),
          yAt(t) - H * 0.014 * s,
          W * 0.032 * s,
          W * 0.011 * s,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }

      // 坡脚压暗：坡面靠水的一侧沉进暗处，不再亮绿直接接水面
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = `rgba(3, 11, 8, ${0.44 - pass * 0.21})`;
        for (let i = 0; i < 22; i++) {
          const t0 = i / 22;
          const t1 = (i + 1) / 22;
          ctx.lineWidth = W * (0.005 + 0.02 * scaleAt(t0)) * (1 + pass * 1.25);
          ctx.beginPath();
          ctx.moveTo(W / 2 + side * halfAt(t0), yAt(t0));
          ctx.lineTo(W / 2 + side * halfAt(t1), yAt(t1));
          ctx.stroke();
        }
      }
    }

    // 河道水面：贴首页那张河流图，用透视切片滚动做出流动感
    this._waterPath(ctx, halfAt, horizon);
    ctx.save();
    ctx.clip();
    this._paintWaterTexture(ctx, horizon, nearHalf, now);
    ctx.restore();

    // ── 两岸树林：前后两排，近大远小，越远越暗 ──
    const trees = [];
    for (const side of [-1, 1]) {
      for (let row = 0; row < 2; row++) {
        const count = row === 0 ? 18 : 20;
        const phase = (this.stats.distance * (row === 0 ? 1.4 : 0.9)) % 1;
        for (let k = 0; k < count; k++) {
          const t = 1 - (k + phase) / count;
          if (t < 0.02 || t > 0.97) continue;
          const s = scaleAt(t);
          const near = row === 0;
          const offW = near
            ? 0.004 + (((k * 37) % 11) / 11) * 0.072
            : 0.082 + (((k * 53) % 13) / 13) * 0.108;
          trees.push({
            side,
            t,
            s,
            row,
            x: W / 2 + side * (halfAt(t) + W * offW * s),
            y: yAt(t) - (near ? 0 : H * 0.012 * s),
            h: H * (near ? 0.62 + (((k * 17) % 7) / 7) * 0.32 : 0.22 + (((k * 29) % 5) / 5) * 0.14) * s,
            needle: (k + row) % 4 !== 0,
            tint: ((k * 23 + row * 7) % 5) / 5,
          });
        }
      }
    }
    trees.sort((a, b) => a.t - b.t);

    // 夜色下的树只剩剪影：压暗、去饱和，靠一层极淡的月光边缘勾出轮廓
    const paintTree = (tr, alpha, mirror = false, stretch = 1) => {
      const { x, y, tint, needle } = tr;
      const h = tr.h * stretch;
      const dir = mirror ? -1 : 1;
      const tw = h * 0.22;
      ctx.globalAlpha = alpha;
      if (!mirror) {
        ctx.fillStyle = 'rgba(3, 12, 8, 0.32)';
        ctx.beginPath();
        ctx.ellipse(x, y + h * 0.015, tw * 0.9, tw * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.lineCap = 'round';
      ctx.strokeStyle = mirror ? 'rgba(5, 18, 13, 0.95)' : 'rgba(8, 21, 15, 0.98)';
      ctx.lineWidth = Math.max(1, h * 0.012);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - dir * h * 0.5);
      ctx.stroke();
      ctx.fillStyle = mirror
        ? 'rgba(16, 52, 38, 0.92)'
        : `rgba(${Math.round(9 + tint * 7)}, ${Math.round(30 + tint * 14)}, ${Math.round(19 + tint * 9)}, 0.98)`;
      if (needle) {
        for (let i = 0; i < 4; i++) {
          const w = tw * (1 - i * 0.21);
          const by = y - dir * h * (0.3 + i * 0.165);
          ctx.beginPath();
          ctx.moveTo(x, by - dir * h * 0.235);
          ctx.lineTo(x - w, by + dir * h * 0.07);
          ctx.lineTo(x + w, by + dir * h * 0.07);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        const crownY = y - dir * h * 0.62;
        ctx.beginPath();
        ctx.ellipse(x, crownY, tw * 0.42, tw * 0.72, 0, 0, Math.PI * 2);
        ctx.ellipse(x - tw * 0.34, crownY + dir * h * 0.05, tw * 0.3, tw * 0.52, 0, 0, Math.PI * 2);
        ctx.ellipse(x + tw * 0.36, crownY + dir * h * 0.03, tw * 0.32, tw * 0.54, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!mirror) {
        ctx.strokeStyle = 'rgba(150, 205, 178, 0.07)';
        ctx.lineWidth = Math.max(0.6, h * 0.008);
        ctx.beginPath();
        ctx.arc(x - tw * 0.18, y - h * 0.72, tw * 0.62, Math.PI * 1.02, Math.PI * 1.52);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    // 近岸水色顺势暗下去，不做任何形状化倒影：形状一硬就假
    ctx.save();
    this._waterPath(ctx, halfAt, horizon);
    ctx.clip();
    const edgeShade = ctx.createLinearGradient(0, 0, W, 0);
    edgeShade.addColorStop(0, 'rgba(5, 20, 16, 0.18)');
    edgeShade.addColorStop(0.17, 'rgba(5, 20, 16, 0)');
    edgeShade.addColorStop(0.83, 'rgba(5, 20, 16, 0)');
    edgeShade.addColorStop(1, 'rgba(5, 20, 16, 0.18)');
    ctx.fillStyle = edgeShade;
    ctx.fillRect(0, horizon, W, H - horizon);

    // 沿岸线的柔和暗带：顺着河岸曲线铺进水面，几层叠加做出渐隐，
    // 岸脚就不会突然亮起来
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        pts.push([W / 2 + side * halfAt(t), yAt(t), scaleAt(t)]);
      }
      for (let pass = 0; pass < 3; pass++) {
        ctx.strokeStyle = `rgba(4, 16, 11, ${0.3 - pass * 0.09})`;
        for (let i = 0; i < pts.length - 1; i++) {
          ctx.lineWidth = W * (0.009 + 0.026 * pts[i][2]) * (1 + pass * 1.1);
          ctx.beginPath();
          ctx.moveTo(pts[i][0], pts[i][1]);
          ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
          ctx.stroke();
        }
      }
    }

    // 峡谷薄雾：远雾留到最后统一压一层，见 _drawRoad 末尾
    ctx.restore();

    // 岸线本身再压一道暗：一半压坡面、一半压水面，把水陆交界的硬边化掉
    for (const side of [-1, 1]) {
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = `rgba(4, 14, 10, ${0.3 - pass * 0.15})`;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i < 40; i++) {
          const t0 = i / 40;
          const t1 = (i + 1) / 40;
          ctx.lineWidth = W * (0.004 + 0.012 * scaleAt(t0)) * (1 + pass * 1.5);
          ctx.beginPath();
          ctx.moveTo(W / 2 + side * halfAt(t0), yAt(t0));
          ctx.lineTo(W / 2 + side * halfAt(t1), yAt(t1));
          ctx.stroke();
        }
      }
    }

    // ── 坡脚灌丛：贴着岸线长，跨到水面一侧，把水陆交界咬碎 ──
    for (const side of [-1, 1]) {
      for (let k = 0; k < 34; k++) {
        const t = 1 - (k + 0.5) / 34;
        if (t < 0.05 || t > 0.97) continue;
        const s = scaleAt(t);
        const jitter = ((k * 41) % 9) / 9 - 0.4;
        const r = W * (0.010 + (((k * 13) % 5) / 5) * 0.015) * s;
        const cx = W / 2 + side * (halfAt(t) + W * 0.022 * jitter * s);
        const cy = yAt(t) - r * 0.15;
        ctx.fillStyle = `rgba(${11 + (k % 3) * 4}, ${31 + (k % 4) * 7}, ${20 + (k % 3) * 5}, 0.94)`;
        ctx.beginPath();
        ctx.ellipse(cx, cy - r * 0.42, r * 1.35, r * 0.8, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - side * r * 0.85, cy - r * 0.16, r * 0.82, r * 0.52, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + side * r * 0.9, cy - r * 0.2, r * 0.88, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // 岸石：一半踩在坡上、一半浸在水里，靠苔藓色把硬边切成锯齿
      for (let k = 0; k < 9; k++) {
        const t = 1 - ((k * 0.618 + 0.06) % 1);
        if (t < 0.06 || t > 0.96) continue;
        const tj = Math.min(0.96, Math.max(0.06, t + (((k * 31) % 7) / 7 - 0.5) * 0.09));
        const s = scaleAt(tj);
        const r = W * (0.006 + (((k * 19) % 5) / 5) * 0.016) * s;
        const cx = W / 2 + side * (halfAt(tj) + W * 0.01 * (((k * 29) % 5) / 5 - 0.5) * s);
        const cy = yAt(tj);
        ctx.fillStyle = `rgba(${25 + (k % 3) * 6}, ${39 + (k % 4) * 7}, ${32 + (k % 3) * 5}, 0.92)`;
        ctx.beginPath();
        ctx.ellipse(cx, cy - r * 0.22, r * 1.15, r * 0.62, 0, 0, Math.PI * 2);
        ctx.fill();
        // 石头上的苔藓
        ctx.fillStyle = `rgba(${22 + (k % 3) * 4}, ${44 + (k % 4) * 5}, ${29 + (k % 3) * 4}, 0.55)`;
        ctx.beginPath();
        ctx.ellipse(cx, cy - r * 0.46, r * 0.86, r * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const tr of trees) paintTree(tr, 1, false);

    // 水面反光
    const sheen = ctx.createLinearGradient(0, horizon, 0, H);
    sheen.addColorStop(0, 'rgba(140, 232, 214, 0)');
    sheen.addColorStop(0.6, 'rgba(232, 252, 248, 0.06)');
    sheen.addColorStop(1, 'rgba(232, 252, 248, 0.15)');
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
      g.addColorStop(0, 'rgba(150, 200, 180, 0.02)');
      g.addColorStop(1, 'rgba(160, 210, 190, 0.07)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.2;
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
        ctx.fillStyle = `rgba(52, 104, 72, ${0.1 + 0.24 * s})`;
        ctx.beginPath();
        ctx.ellipse(cx, y - W * 0.002 * s, W * 0.01 * s, W * 0.003 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 远端雾化：路面在地平线处淡入，避免生硬的梯形收口。
    // 渐变必须跨过地平线——从线上方就开始加深，否则 horizon 会留下一条全幅横向硬边。
    const fadeTop = horizon - H * 0.035;
    const fadeH = H * 0.15;
    const fade = ctx.createLinearGradient(0, fadeTop, 0, fadeTop + fadeH);
    fade.addColorStop(0, 'rgba(9, 32, 28, 0)');
    fade.addColorStop(0.24, 'rgba(9, 32, 28, 0.74)');
    fade.addColorStop(1, 'rgba(9, 32, 28, 0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, fadeTop, W, fadeH);
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

    // 把贴图拉向参考图的玉青色，再补一层极淡的白提亮
    ctx.fillStyle = 'rgba(7, 34, 31, 0.52)';
    ctx.fillRect(0, horizon, W, span);
    // 远端雾化：地平线附近柔化，避免贴图起始处出现硬边
    const fade = ctx.createLinearGradient(0, horizon, 0, horizon + span * 0.34);
    fade.addColorStop(0, 'rgba(9, 32, 28, 0.94)');
    fade.addColorStop(0.55, 'rgba(9, 32, 28, 0.4)');
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
        rock.addColorStop(0, '#48544f');
        rock.addColorStop(0.55, '#37423d');
        rock.addColorStop(1, '#232d2a');
        ctx.fillStyle = rock;
        ctx.fill();
        // 吃水线：与水面交接处提一点亮，石头才不会像浮在图上的贴片
        ctx.strokeStyle = 'rgba(186, 232, 216, 0.26)';
        ctx.lineWidth = Math.max(1, 1.6 * p.scale);
        ctx.beginPath();
        ctx.moveTo(p.x - bw * 0.5, p.y + 0.5);
        ctx.lineTo(p.x + bw * 0.5, p.y + 0.5);
        ctx.stroke();
        // 顶部受光棱
        ctx.strokeStyle = 'rgba(178, 210, 196, 0.24)';
        ctx.lineWidth = Math.max(1, 2 * p.scale);
        ctx.beginPath();
        ctx.moveTo(p.x - bw * 0.18, p.y - bh * 0.94);
        ctx.lineTo(p.x + bw * 0.16, p.y - bh * 1.0);
        ctx.stroke();
        // 苔藓
        ctx.fillStyle = 'rgba(58, 104, 68, 0.55)';
        ctx.beginPath();
        ctx.ellipse(p.x - bw * 0.1, p.y - bh * 0.86, bw * 0.2, bh * 0.09, -0.3, 0, Math.PI * 2);
        ctx.fill();
      } else if (ob.type === ObstacleType.LOW) {
        // 横在河面的倒木：跳过去
        const lh = h * 0.34;
        const wood = ctx.createLinearGradient(0, p.y - lh, 0, p.y);
        wood.addColorStop(0, '#57402b');
        wood.addColorStop(0.55, '#3b2b1d');
        wood.addColorStop(1, '#211710');
        ctx.fillStyle = wood;
        this._roundRect(ctx, p.x - w / 2, p.y - lh, w, lh, lh * 0.42);
        ctx.fill();
        // 端面年轮
        ctx.fillStyle = '#8b6647';
        ctx.beginPath();
        ctx.ellipse(p.x - w / 2 + lh * 0.34, p.y - lh / 2, lh * 0.22, lh * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(66, 44, 29, 0.85)';
        ctx.lineWidth = Math.max(0.6, 1.2 * p.scale);
        ctx.beginPath();
        ctx.ellipse(p.x - w / 2 + lh * 0.34, p.y - lh / 2, lh * 0.11, lh * 0.18, 0, 0, Math.PI * 2);
        ctx.stroke();
        // 苔藓
        ctx.fillStyle = 'rgba(56, 104, 64, 0.72)';
        this._roundRect(ctx, p.x - w * 0.36, p.y - lh, w * 0.56, Math.max(1.2, lh * 0.26), 2 * p.scale);
        ctx.fill();
      } else {
        // 低垂树枝：滑铲通过
        const barY = p.y - h * 1.12;
        const barH = Math.max(1.6, h * 0.2);
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#4a3220';
        ctx.lineWidth = Math.max(2, 7 * p.scale);
        ctx.beginPath();
        ctx.moveTo(p.x - w * 0.54, barY - barH * 0.5);
        ctx.quadraticCurveTo(p.x, barY + barH * 0.85, p.x + w * 0.54, barY - barH * 0.4);
        ctx.stroke();
        // 叶簇
        ctx.fillStyle = 'rgba(56, 116, 70, 0.9)';
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
        ctx.strokeStyle = 'rgba(50, 104, 64, 0.45)';
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
    // 第一人称船头：用照片抠出的船头贴在画面底部，透视就是参考图本身的视角。
    // 图未就绪（或加载失败）时退回原来的俯视小船。
    const bowReady = this.bow && this.bow.complete && this.bow.naturalWidth > 0;
    if (!bowReady) return this._drawPlayerTopDown(ctx, now);

    const { W, H } = this;
    const off = this.laneVisual - (this.laneCount - 1) / 2;

    let lift = 0;
    let dip = 0;
    let scale = 1;
    let squash = 1;
    if (this.jumping(now)) {
      const k = 1 - (this.jumpUntil - now) / this.jumpMs;
      lift = Math.sin(Math.PI * k) * H * 0.11;
      scale = 1 + lift / (H * 2.8);
    } else if (this.sliding(now)) {
      dip = H * 0.03;
      squash = 0.8;
    }

    const x = W / 2 + off * W * 0.3;
    const bw = W * 0.2 * scale;
    const bh = bw / (this.bow.naturalWidth / this.bow.naturalHeight);
    const bottom = H + dip - lift;

    // 船头劈开水面：两侧各一道细浪，跳起来时跟着走
    ctx.fillStyle = 'rgba(206, 246, 236, 0.18)';
    for (const sd of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + sd * bw * 0.31, bottom - bh * 0.14, bw * 0.1, bh * 0.028, sd * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }

    const blink = now < this.invulnUntil && Math.floor(now / 90) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = blink ? 0.42 : 1;
    ctx.translate(x, bottom);
    ctx.scale(1, squash);
    ctx.drawImage(this.bow, -bw / 2, -bh, bw, bh);
    ctx.restore();

    // 船头与水面的接触阴影：把贴图底边压进水里，跳起时也不露硬边
    const wet = ctx.createRadialGradient(x, bottom - bh * 0.03, 0, x, bottom - bh * 0.03, bw * 0.46);
    wet.addColorStop(0, 'rgba(4, 22, 24, 0.6)');
    wet.addColorStop(0.65, 'rgba(4, 22, 24, 0.28)');
    wet.addColorStop(1, 'rgba(4, 22, 24, 0)');
    ctx.fillStyle = wet;
    ctx.beginPath();
    ctx.ellipse(x, bottom - bh * 0.02, bw * 0.46, bh * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    if (this.shielded(now)) {
      ctx.strokeStyle = 'rgba(160, 255, 235, 0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(x, bottom - bh * 0.44, bw * 0.36, bh * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawPlayerTopDown(ctx, now) {
    const { W, H } = this;
    const off = this.laneVisual - (this.laneCount - 1) / 2;
    const baseY = H * 0.9;
    const x = W / 2 + off * W * 0.3;

    let y = baseY;
    let lift = 0;
    const sliding = this.sliding(now);
    if (this.jumping(now)) {
      const k = 1 - (this.jumpUntil - now) / this.jumpMs; // 0→1
      lift = Math.sin(Math.PI * k) * H * 0.17;
      y = baseY - lift;
    } else if (sliding) {
      y = baseY + H * 0.015;
    }

    // 俯视整条小船：船头朝上，中后段近乎平行，船尾方角，舱口敞开
    const w = W * 0.065 * (sliding ? 1.12 : 1) * (1 + lift / (H * 5));
    const L = w * (sliding ? 2.5 : 3.4);
    const cy = y - L * 0.3;
    const ty = cy - L * 0.52; // 船头
    const by = cy + L * 0.48; // 船尾

    const hull = () => {
      ctx.beginPath();
      ctx.moveTo(x, ty);
      ctx.bezierCurveTo(x + w * 0.09, ty + L * 0.1, x + w * 0.33, ty + L * 0.17, x + w * 0.45, ty + L * 0.29);
      ctx.bezierCurveTo(x + w * 0.5, ty + L * 0.4, x + w * 0.5, cy + L * 0.1, x + w * 0.48, by - L * 0.05);
      ctx.quadraticCurveTo(x + w * 0.46, by, x + w * 0.34, by);
      ctx.lineTo(x - w * 0.34, by);
      ctx.quadraticCurveTo(x - w * 0.46, by, x - w * 0.48, by - L * 0.05);
      ctx.bezierCurveTo(x - w * 0.5, cy + L * 0.1, x - w * 0.5, ty + L * 0.4, x - w * 0.45, ty + L * 0.29);
      ctx.bezierCurveTo(x - w * 0.33, ty + L * 0.17, x - w * 0.09, ty + L * 0.1, x, ty);
      ctx.closePath();
    };

    // 舱口：舷边以内那一圈，船中后段基本等宽
    const inner = () => {
      ctx.beginPath();
      ctx.moveTo(x, ty + L * 0.175);
      ctx.bezierCurveTo(x + w * 0.07, ty + L * 0.222, x + w * 0.255, ty + L * 0.282, x + w * 0.335, ty + L * 0.378);
      ctx.bezierCurveTo(x + w * 0.378, ty + L * 0.47, x + w * 0.378, cy + L * 0.1, x + w * 0.355, by - L * 0.1);
      ctx.quadraticCurveTo(x + w * 0.34, by - L * 0.055, x + w * 0.245, by - L * 0.055);
      ctx.lineTo(x - w * 0.245, by - L * 0.055);
      ctx.quadraticCurveTo(x - w * 0.34, by - L * 0.055, x - w * 0.355, by - L * 0.1);
      ctx.bezierCurveTo(x - w * 0.378, cy + L * 0.1, x - w * 0.378, ty + L * 0.47, x - w * 0.335, ty + L * 0.378);
      ctx.bezierCurveTo(x - w * 0.255, ty + L * 0.282, x - w * 0.07, ty + L * 0.222, x, ty + L * 0.175);
      ctx.closePath();
    };

    // 尾流：船尾往后拖出的两道白痕
    const wake = ctx.createLinearGradient(x, by, x, by + L * 0.52);
    wake.addColorStop(0, 'rgba(198, 246, 236, 0.18)');
    wake.addColorStop(1, 'rgba(198, 246, 236, 0)');
    ctx.fillStyle = wake;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.28, by - L * 0.03);
    ctx.lineTo(x + w * 0.28, by - L * 0.03);
    ctx.lineTo(x + w * 0.86, by + L * 0.52);
    ctx.lineTo(x - w * 0.86, by + L * 0.52);
    ctx.closePath();
    ctx.fill();

    // 船头那一小撮被切开的水花，贴着木头才不显假
    ctx.fillStyle = 'rgba(210, 246, 236, 0.16)';
    ctx.beginPath();
    ctx.ellipse(x, ty + L * 0.012, w * 0.1, L * 0.022, 0, 0, Math.PI * 2);
    ctx.fill();

    // 水面投影：船底压在水上那一圈暗
    ctx.save();
    ctx.translate(x, cy + L * 0.014);
    ctx.scale(1.06, 1.03);
    ctx.translate(-x, -cy);
    hull();
    ctx.fillStyle = 'rgba(2, 12, 10, 0.46)';
    ctx.fill();
    ctx.restore();

    // 船体：俯视只看见舷边，左舷受光、右舷背光
    const hullGrad = ctx.createLinearGradient(x - w * 0.5, cy, x + w * 0.5, cy);
    hullGrad.addColorStop(0, '#5f4126');
    hullGrad.addColorStop(0.32, '#4e341d');
    hullGrad.addColorStop(0.7, '#33230f');
    hullGrad.addColorStop(1, '#1e1408');
    hull();
    ctx.fillStyle = hullGrad;
    ctx.fill();

    // 船头一段压暗，避免整条船一个调子
    ctx.save();
    hull();
    ctx.clip();
    const nose = ctx.createLinearGradient(x, ty, x, ty + L * 0.34);
    nose.addColorStop(0, 'rgba(6, 4, 2, 0.42)');
    nose.addColorStop(1, 'rgba(6, 4, 2, 0)');
    ctx.fillStyle = nose;
    ctx.fillRect(x - w, ty, w * 2, L * 0.4);
    ctx.restore();

    // 舱内：越往里越黑，只看得出一点底板
    inner();
    const cavity = ctx.createLinearGradient(x, ty, x, by);
    cavity.addColorStop(0, '#211710');
    cavity.addColorStop(0.45, '#150e07');
    cavity.addColorStop(1, '#241809');
    ctx.fillStyle = cavity;
    ctx.fill();

    ctx.save();
    inner();
    ctx.clip();
    // 舱底纵向板缝
    ctx.strokeStyle = 'rgba(138, 100, 62, 0.42)';
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      const bx = x + i * w * 0.148;
      ctx.beginPath();
      ctx.moveTo(bx, ty + L * 0.19);
      ctx.lineTo(bx, by - L * 0.05);
      ctx.stroke();
    }
    // 舱底一点暖反光：夜里能看出这是个敞开的空腔
    const glow = ctx.createRadialGradient(x, cy + L * 0.09, 0, x, cy + L * 0.09, L * 0.34);
    glow.addColorStop(0, 'rgba(255, 166, 90, 0.12)');
    glow.addColorStop(1, 'rgba(255, 166, 90, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - w, ty, w * 2, L);

    // 两道横座板：横跨舱口，是俯视最容易读出"船"的结构
    const seatH = Math.max(4, L * 0.05);
    const seatY = [cy + L * 0.025, cy + L * 0.2];
    for (const sy of seatY) {
      ctx.fillStyle = '#5b3f27';
      ctx.fillRect(x - w * 0.5, sy, w, seatH);
      ctx.fillStyle = 'rgba(168, 128, 82, 0.5)';
      ctx.fillRect(x - w * 0.5, sy, w, Math.max(1, seatH * 0.26));
      ctx.fillStyle = 'rgba(8, 5, 3, 0.55)';
      ctx.fillRect(x - w * 0.5, sy + seatH - Math.max(1, seatH * 0.22), w, Math.max(1, seatH * 0.22));
    }

    // 船尾横板
    ctx.fillStyle = '#48301c';
    ctx.fillRect(x - w * 0.36, by - L * 0.095, w * 0.72, L * 0.042);
    ctx.fillStyle = 'rgba(158, 118, 74, 0.45)';
    ctx.fillRect(x - w * 0.36, by - L * 0.095, w * 0.72, Math.max(1, L * 0.01));
    ctx.restore();

    // 船头：照片抠图压暗后的精灵图，图没就绪时退回程序化绘制
    const bowReady = this.bow && this.bow.complete && this.bow.naturalWidth > 0;
    if (bowReady) {
      const srcH = this.bow.naturalHeight * 0.62;
      const bh = w * 0.6;
      const bw = bh * (this.bow.naturalWidth / srcH);
      ctx.save();
      hull();
      ctx.clip();
      ctx.drawImage(this.bow, 0, 0, this.bow.naturalWidth, srcH,
        x - bw / 2, ty - L * 0.004, bw, bh);
      ctx.restore();
    } else {
      // 船头甲板：舱口之前那一段封闭木板。必须在 hull 裁剪里画，
      // 若在 inner() 裁剪里画，船头（舱口以外）会被裁掉，甲板就消失了
      ctx.save();
      hull();
      ctx.clip();
      const deck = ctx.createLinearGradient(x, ty, x, ty + L * 0.185);
      deck.addColorStop(0, '#D9B384');
      deck.addColorStop(0.55, '#C2965F');
      deck.addColorStop(1, '#A87C49');
      ctx.fillStyle = deck;
      ctx.fillRect(x - w * 0.44, ty, w * 0.88, L * 0.185);
      // 板缝顺船身方向铺，越靠近船尖越往中线收
      ctx.strokeStyle = 'rgba(96, 64, 34, 0.55)';
      ctx.lineWidth = Math.max(1, w * 0.012);
      ctx.beginPath();
      for (let i = -2; i <= 1; i++) {
        const bx = x + i * w * 0.11;
        const pull = i * w * 0.03;
        ctx.moveTo(bx - pull, ty + L * 0.015);
        ctx.quadraticCurveTo(bx - pull * 0.4, ty + L * 0.1, bx, ty + L * 0.185);
      }
      ctx.stroke();
      // 左上方来的柔光
      const deckLight = ctx.createLinearGradient(x - w * 0.4, ty, x + w * 0.4, ty + L * 0.12);
      deckLight.addColorStop(0, 'rgba(255, 240, 214, 0.22)');
      deckLight.addColorStop(1, 'rgba(255, 240, 214, 0)');
      ctx.fillStyle = deckLight;
      ctx.fillRect(x - w * 0.44, ty, w * 0.88, L * 0.12);
      // 舱口前檐：一道横梁把亮色甲板和黑舱口分开
      ctx.fillStyle = '#4a3120';
      ctx.fillRect(x - w * 0.32, ty + L * 0.172, w * 0.64, L * 0.018);
      ctx.fillStyle = 'rgba(150, 112, 70, 0.4)';
      ctx.fillRect(x - w * 0.32, ty + L * 0.172, w * 0.64, Math.max(1, L * 0.005));
      ctx.restore();

      // 船尖系缆环，再是躺在甲板上的花束
      this._drawBowRing(ctx, x, ty + L * 0.028, w, L);
      this._drawBouquet(ctx, x, ty + L * 0.105, w, L);
    }

    // 内壁暗线：有这道凹陷，船才不是一块板
    inner();
    ctx.strokeStyle = 'rgba(5, 3, 1, 0.72)';
    ctx.lineWidth = Math.max(1.5, w * 0.026);
    ctx.stroke();

    // 舷边顶面受光
    hull();
    ctx.strokeStyle = 'rgba(196, 158, 110, 0.45)';
    ctx.lineWidth = Math.max(1, w * 0.014);
    ctx.stroke();

    // 左舷一段更亮的高光，把光源交代清楚
    ctx.strokeStyle = 'rgba(244, 212, 164, 0.28)';
    ctx.lineWidth = Math.max(1, w * 0.016);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.07, ty + L * 0.09);
    ctx.bezierCurveTo(x - w * 0.24, ty + L * 0.17, x - w * 0.45, cy - L * 0.12, x - w * 0.47, cy + L * 0.06);
    ctx.stroke();

    // 长篙斜架在舷上，这类小船最好认的一笔
    const px1 = x - w * 0.78;
    const py1 = ty + L * 0.02;
    const px2 = x + w * 0.34;
    const py2 = by + L * 0.05;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(158, 122, 80, 0.55)';
    ctx.lineWidth = Math.max(1.2, w * 0.018);
    ctx.beginPath();
    ctx.moveTo(px1, py1);
    ctx.lineTo(px2, py2);
    ctx.stroke();
    ctx.translate(px1, py1);
    ctx.rotate(Math.atan2(py1 - py2, px1 - px2));
    ctx.fillStyle = 'rgba(146, 112, 74, 0.58)';
    ctx.beginPath();
    ctx.ellipse(-w * 0.12, 0, w * 0.13, w * 0.042, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 尾侧细小水花
    if (!this.jumping(now)) {
      ctx.fillStyle = 'rgba(214, 250, 240, 0.24)';
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(x + sx * w * 0.44, by - L * 0.08, w * 0.1, L * 0.02, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 护盾光效
    if (this.shielded(now)) {
      const rr = Math.max(w * 0.84, L * 0.29);
      ctx.strokeStyle = 'rgba(160, 255, 235, 0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(x, cy + L * 0.02, rr, rr * 1.1, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 无敌闪烁
    if (now < this.invulnUntil && Math.floor(now / 90) % 2 === 0) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(x, cy + L * 0.02, w * 0.34, L * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /** 花束布局：固定种子 LCG，保证每帧一模一样 */
  _buildBouquet() {
    let seed = 0x5EED;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const flowers = [];
    const spec = [
      // 类型 / 数量 / 花瓣色 / 花心色 / 花瓣数 / 圈数
      ['daisy', 5, '#FFFDF7', '#F0B93C', 8, 1],
      ['cosmos', 4, '#F2A6C4', '#E0709C', 8, 1],
      ['mum', 3, '#F5C63F', '#C98A1E', 12, 2],
      ['orange', 3, '#EE8B3C', '#B45A1C', 12, 2],
    ];
    for (const [type, count, petal, core, petals, rings] of spec) {
      for (let i = 0; i < count; i++) {
        flowers.push({
          type, petal, core, petals, rings,
          dx: (rnd() - 0.5) * 0.52,           // 单位 w
          dy: (rnd() - 0.5) * 0.055 - 0.004,  // 单位 L
          r: 0.0275 + rnd() * 0.015,          // 半径，单位 w
          rot: rnd() * Math.PI,
          slim: type === 'cosmos' ? 0.24 : 0.32,
        });
      }
    }
    const leaves = [];
    for (let i = 0; i < 7; i++) {
      leaves.push({
        dx: (rnd() - 0.5) * 0.46,
        dy: 0.018 + rnd() * 0.042,
        len: 0.055 + rnd() * 0.05,
        rot: (rnd() - 0.5) * 1.5,
        dark: rnd() > 0.5,
      });
    }
    return { flowers, leaves };
  }

  /** 俯视花束：看见的是花瓣顶面，茎朝船尾散开 */
  _drawBouquet(ctx, cx, cy, w, L) {
    this._bowFlowers ||= this._buildBouquet();
    const { flowers, leaves } = this._bowFlowers;
    const px = (f) => cx + f.dx * w;
    const py = (f) => cy + f.dy * L;

    // 一层极淡的暖光晕，让花束从深色船身上浮出来
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.46);
    halo.addColorStop(0, 'rgba(255, 240, 214, 0.1)');
    halo.addColorStop(1, 'rgba(255, 240, 214, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - w * 0.46, cy - w * 0.46, w * 0.92, w * 0.92);

    // 最底层的绿叶剪影，朝船尾方向散开，给花束一点厚度
    for (const lf of leaves) {
      ctx.save();
      ctx.translate(cx + lf.dx * w, cy + lf.dy * L);
      ctx.rotate(lf.rot);
      ctx.fillStyle = lf.dark ? '#55702C' : '#6E8B3D';
      ctx.beginPath();
      ctx.ellipse(0, lf.len * w * 0.4, w * 0.018, lf.len * w * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 花茎：从每个花头收到根部，一条路径画完
    ctx.strokeStyle = 'rgba(85, 112, 44, 0.85)';
    ctx.lineWidth = Math.max(1, w * 0.008);
    ctx.beginPath();
    for (const f of flowers) {
      ctx.moveTo(px(f), py(f));
      ctx.quadraticCurveTo(px(f) * 0.35 + cx * 0.65, (py(f) + cy + L * 0.04) * 0.5, cx, cy + L * 0.042);
    }
    ctx.stroke();

    // 所有花头的投影合并成一条路径：光从左上来，投影落右下
    ctx.fillStyle = 'rgba(40, 25, 12, 0.28)';
    ctx.beginPath();
    for (const f of flowers) {
      ctx.ellipse(px(f) + w * 0.012, py(f) + w * 0.012, f.r * w * 1.05, f.r * w * 0.85, 0, 0, Math.PI * 2);
    }
    ctx.fill();

    // 花瓣顶面：同色系的花瓣合并在一条路径里，一次 fill
    for (const f of flowers) {
      const r = f.r * w;
      ctx.fillStyle = f.petal;
      ctx.beginPath();
      for (let ring = 0; ring < f.rings; ring++) {
        const rr = ring === 0 ? r : r * 0.62;
        const n = ring === 0 ? f.petals : Math.max(6, f.petals - 4);
        for (let i = 0; i < n; i++) {
          const a = f.rot + (i / n) * Math.PI * 2 + ring * 0.26;
          ctx.ellipse(px(f) + Math.cos(a) * rr * 0.52, py(f) + Math.sin(a) * rr * 0.52,
            rr * 0.6, rr * f.slim, a, 0, Math.PI * 2);
        }
      }
      ctx.fill();
      ctx.fillStyle = f.core;
      ctx.beginPath();
      ctx.ellipse(px(f), py(f), r * 0.32, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 根部两道麻绳交叉
    ctx.strokeStyle = '#C9A46A';
    ctx.lineWidth = Math.max(1, w * 0.012);
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.1, cy + L * 0.032);
    ctx.quadraticCurveTo(cx, cy + L * 0.05, cx + w * 0.1, cy + L * 0.036);
    ctx.moveTo(cx - w * 0.1, cy + L * 0.048);
    ctx.quadraticCurveTo(cx, cy + L * 0.03, cx + w * 0.1, cy + L * 0.05);
    ctx.stroke();
  }

  /** 船尖系缆环：俯视是被压扁的椭圆 */
  _drawBowRing(ctx, x, y, w, L) {
    const rx = w * 0.0375;
    const ry = Math.max(1.2, L * 0.006);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(x + w * 0.006, y + ry * 0.9, rx * 1.15, ry * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(24, 22, 18, 0.85)';
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 0.72, ry * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#9E9A90';
    ctx.lineWidth = Math.max(1.2, w * 0.016);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = Math.max(1, w * 0.008);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, Math.PI * 0.95, Math.PI * 1.6);
    ctx.stroke();
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

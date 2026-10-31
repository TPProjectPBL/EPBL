/**
 * M13 · 画笔渲染引擎
 *
 * 对应《开工方案》9.2：轨迹平滑、笔宽与透明度、撤销、清空、导出 PNG。
 *
 * 设计要点：
 *   - 所有点用**归一化坐标 [0,1]** 存储 → 与分辨率解耦，窗口缩放/导出任意尺寸都不失真；
 *   - 两层结构：committed（离屏画布，已完成的笔画栅格化）+ live（当前正在画的笔画）；
 *   - 只有「撤销 / 清空 / 换背景」时才重绘全部历史笔画，常态每帧只画 live，性能可控；
 *   - 轨迹平滑用「二次贝塞尔过中点」，线条明显更顺，且不会像样条那样过冲。
 */

/** 相邻点最小间距（归一化），用于抽稀，避免高速移动时点数爆炸 */
const MIN_STEP = 0.0012;

/** 把一条笔画路径画到给定上下文（live 与 committed 共用，保证视觉一致） */
export function drawStroke(ctx, stroke, W, H) {
  const pts = stroke.points;
  if (!pts || !pts.length) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = stroke.alpha;
  ctx.strokeStyle = stroke.color;

  if (stroke.glow) {
    ctx.shadowColor = stroke.color;
    ctx.shadowBlur = Math.max(6, stroke.width * 2.4);
  }

  if (pts.length === 1) {
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(pts[0].x * W, pts[0].y * H, Math.max(0.6, stroke.width / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  ctx.moveTo(pts[0].x * W, pts[0].y * H);
  // 二次贝塞尔：控制点取原始点，端点取相邻点中点 → 曲线更顺
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i];
    const n = pts[i + 1];
    ctx.quadraticCurveTo(c.x * W, c.y * H, ((c.x + n.x) / 2) * W, ((c.y + n.y) / 2) * H);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * W, last.y * H);
  ctx.stroke();
  ctx.restore();
}

export class BrushEngine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.color = options.color || '#ffd166';
    this.width = options.width || 6;
    this.alpha = options.alpha ?? 1;
    this.glow = options.glow ?? true;
    this.background = options.background || '#0b1020';

    this.strokes = []; // 已完成的笔画（用于撤销 / 重绘）
    this.live = null; // 当前笔画
    this.maxStrokes = options.maxStrokes || 400;

    this.committed = document.createElement('canvas');
    this.cctx = this.committed.getContext('2d');

    this.resize();
    this.onChange = options.onChange || null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    this.cssW = w;
    this.cssH = h;

    for (const c of [this.canvas, this.committed]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.cctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
    this.cctx.scale(this.dpr, this.dpr);

    this._restrokes();
    this.render();
  }

  /** 清空自身上下文并重绘：白底/深底由 CSS 负责，画布本身保持透明 */
  _clear(ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  _restrokes() {
    this._clear(this.cctx);
    for (const s of this.strokes) drawStroke(this.cctx, s, this.cssW, this.cssH);
  }

  /** 每帧调用：committed + live 合成到可见画布 */
  render() {
    this._clear(this.ctx);
    this.ctx.drawImage(
      this.committed,
      0,
      0,
      this.committed.width,
      this.committed.height,
      0,
      0,
      this.cssW,
      this.cssH,
    );
    if (this.live) drawStroke(this.ctx, this.live, this.cssW, this.cssH);
  }

  begin(x, y) {
    this.live = {
      color: this.color,
      width: this.width,
      alpha: this.alpha,
      glow: this.glow,
      points: [{ x, y }],
    };
    this.render();
    this._emit();
  }

  move(x, y) {
    if (!this.live) return;
    const pts = this.live.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(x - last.x, y - last.y) < MIN_STEP) return;
    pts.push({ x, y });
    this.render();
  }

  end() {
    if (!this.live) return;
    if (this.live.points.length === 1) {
      // 点一下也要留个点，否则"点画"会消失
      this.strokes.push(this.live);
    } else {
      this.strokes.push(this.live);
    }
    this.live = null;
    if (this.strokes.length > this.maxStrokes) this.strokes.shift();
    this._restrokes();
    this.render();
    this._emit();
  }

  get drawing() {
    return !!this.live;
  }

  undo() {
    if (this.live) {
      this.live = null;
    } else {
      this.strokes.pop();
    }
    this._restrokes();
    this.render();
    this._emit();
  }

  clear() {
    this.live = null;
    this.strokes = [];
    this._restrokes();
    this.render();
    this._emit();
  }

  get isEmpty() {
    return this.strokes.length === 0 && !this.live;
  }

  setColor(color) {
    this.color = color;
    this._emit();
  }
  setWidth(w) {
    this.width = w;
    this._emit();
  }
  setAlpha(a) {
    this.alpha = a;
    this._emit();
  }
  setGlow(on) {
    this.glow = !!on;
    this._emit();
  }

  /** 夜/纸 两种舞台底 */
  setBackground(color) {
    this.background = color;
    this._emit();
  }

  _emit() {
    if (this.onChange) this.onChange(this);
  }

  /**
   * 导出 PNG。会把舞台底色一并烘进图片，避免透明底在聊天软件里显示成黑色/白色意外。
   * @returns {string} dataURL
   */
  exportPNG() {
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, out.width, out.height);
    // 按 CSS 单位 + dpr 缩放重绘，保证导出图的线宽与屏幕观感一致
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const s of this.strokes) drawStroke(ctx, s, this.cssW, this.cssH);
    if (this.live) drawStroke(ctx, this.live, this.cssW, this.cssH);
    return out.toDataURL('image/png');
  }
}

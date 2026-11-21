/**
 * @file 纯 DOM 标定覆盖层。
 *
 * 不依赖任何页面 CSS：所有样式内联，颜色变量统一用 `--gaze-cal-*` 前缀，
 * 由调用方在 root 上覆盖即可换主题（跑酷页不需要改 ui.css）。
 *
 * 坐标：用 container.getBoundingClientRect() + 点相对坐标，元素用 position: fixed，
 * 因此容器在 iframe 内、或在父页面里都能正确定位（都相对各自文档的视口）。
 */

const DEFAULT_POINTS = [
  [0.1, 0.12],
  [0.5, 0.12],
  [0.9, 0.12],
  [0.1, 0.5],
  [0.5, 0.5],
  [0.9, 0.5],
  [0.1, 0.88],
  [0.5, 0.88],
  [0.9, 0.88],
];

function toPoint(p) {
  return Array.isArray(p) ? { tx: Number(p[0]), ty: Number(p[1]) } : { tx: Number(p.tx), ty: Number(p.ty) };
}

export function createOverlay(options = {}) {
  const {
    container,
    points = DEFAULT_POINTS,
    onCancel,
    onPointClick = null,
    label = '眼动标定',
    zIndex = 2147483000,
  } = options;

  if (!container || typeof container.getBoundingClientRect !== 'function') {
    throw new TypeError('createOverlay: container 必须提供 getBoundingClientRect()');
  }

  const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) throw new Error('createOverlay: 找不到可挂载的 document.body');

  const win = doc.defaultView || null;
  const pts = points.map(toPoint);
  const timers = new Set();

  const root = doc.createElement('div');
  root.setAttribute('data-gaze-cal-overlay', '1');
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:' + Number(zIndex),
    'pointer-events:none',
    'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
    '--gaze-cal-accent:#a9db7b',
    '--gaze-cal-idle:#8fa0a8',
    '--gaze-cal-done:#46c98a',
    '--gaze-cal-bad:#ff6b6b',
    '--gaze-cal-track:rgba(255,255,255,0.35)',
    '--gaze-cal-ink:#eef6ef',
    '--gaze-cal-bg:rgba(8,24,18,0.72)',
  ].join(';');

  const hud = doc.createElement('div');
  hud.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:18px',
    'transform:translateX(-50%)',
    'padding:8px 14px',
    'border-radius:999px',
    'background:var(--gaze-cal-bg)',
    'color:var(--gaze-cal-ink)',
    'font-size:13px',
    'line-height:1.3',
    'letter-spacing:0.02em',
    'white-space:nowrap',
    'backdrop-filter:blur(6px)',
    'pointer-events:none',
  ].join(';');
  // 用文本节点而不是 textContent：更新文案时不能把状态点一起清掉
  const hudText = doc.createTextNode(label);
  hud.appendChild(hudText);

  // 眼睛捕获状态：看不清光标时，用户要能立刻区分「没检测到人脸」和「跟得不准」
  const eye = doc.createElement('i');
  eye.style.cssText = [
    'display:inline-block',
    'width:7px',
    'height:7px',
    'border-radius:50%',
    'margin-left:8px',
    'vertical-align:middle',
    'background:var(--gaze-cal-idle)',
    'transition:background .18s ease',
  ].join(';');
  hud.appendChild(eye);
  root.appendChild(hud);

  const tip = doc.createElement('div');
  tip.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:54px',
    'transform:translateX(-50%)',
    'font-size:13px',
    'letter-spacing:.02em',
    'color:var(--gaze-cal-track)',
    'white-space:nowrap',
    'pointer-events:none',
    'opacity:.9',
  ].join(';');
  tip.textContent = '盯住亮起的圆点：头保持在虚线框里；共 9 个点，点间停 1 秒';
  // 只有标定阶段需要这句；准确率测试阶段顶部已经有自己的说明
  if (label.indexOf('标定') < 0) tip.style.display = 'none';
  root.appendChild(tip);

  /* ---------------------------------------------------------- 头控小窗 */
  /**
   * 右下角摄像头小窗：画面里画一个虚线「标准框」，实时头框和它大致重合就是绿的。
   *
   * 阈值完全沿用 gaze-heatmap 融合前版本（shared/gaze/contract.js 的 HEAD）：
   * 脸高 0.22~0.80（太近/太远）、居中 0.17/0.20、roll 12°、yaw 17°、pitch 5~68°，
   * 以及相对基准的 0.055/0.065/0.10 位移与 5°/7°/8° 角度。没有单独拿 10° 一刀切。
   */
  const AXES = [
    { key: 'dRoll', label: 'ROLL' },
    { key: 'dYaw', label: 'YAW' },
    { key: 'dPitch', label: 'PITCH' },
  ];

  const camBox = doc.createElement('div');
  camBox.style.cssText = [
    'position:absolute',
    'right:16px',
    'bottom:16px',
    'width:236px',
    'border-radius:12px',
    'overflow:hidden',
    'background:var(--gaze-cal-bg)',
    'color:var(--gaze-cal-ink)',
    'border:2px solid var(--gaze-cal-idle)',
    'box-shadow:0 10px 30px rgba(0,0,0,.34)',
    'backdrop-filter:blur(8px)',
    'pointer-events:none',
    'z-index:1',
    'transition:border-color .16s ease',
  ].join(';');

  const camWrap = doc.createElement('div');
  camWrap.style.cssText = 'position:relative;width:236px;height:133px;background:#0b1512';
  const camCanvas = doc.createElement('canvas');
  camCanvas.width = 236;
  camCanvas.height = 133;
  camCanvas.style.cssText = 'display:block;width:236px;height:133px';
  camWrap.appendChild(camCanvas);

  const camBadge = doc.createElement('div');
  camBadge.style.cssText = [
    'position:absolute',
    'left:8px',
    'bottom:8px',
    'display:flex',
    'align-items:center',
    'gap:5px',
    'padding:3px 8px',
    'border-radius:999px',
    'background:rgba(8,24,18,.72)',
    'color:var(--gaze-cal-ink)',
    'font-size:10px',
    'line-height:1.2',
    'white-space:nowrap',
    'max-width:220px',
    'overflow:hidden',
    'text-overflow:ellipsis',
  ].join(';');
  const camBadgeDot = doc.createElement('i');
  camBadgeDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--gaze-cal-idle);flex:0 0 auto';
  const camBadgeText = doc.createTextNode('等待画面');
  camBadge.appendChild(camBadgeDot);
  camBadge.appendChild(camBadgeText);
  camWrap.appendChild(camBadge);

  const camTag = doc.createElement('div');
  camTag.textContent = 'PREVIEW · 仅本机处理';
  camTag.style.cssText = [
    'position:absolute',
    'right:8px',
    'top:8px',
    'font-size:9px',
    'letter-spacing:.06em',
    'color:rgba(238,246,239,.72)',
    'pointer-events:none',
  ].join(';');
  camWrap.appendChild(camTag);
  camBox.appendChild(camWrap);

  const tiltWrap = doc.createElement('div');
  tiltWrap.style.cssText = 'padding:8px 10px 9px;display:grid;gap:3px';
  const axisNodes = AXES.map((ax) => {
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:7px;height:15px';
    const name = doc.createElement('span');
    name.textContent = ax.label;
    name.style.cssText = 'width:40px;font-size:9px;opacity:.66;letter-spacing:.08em';
    const bar = doc.createElement('div');
    bar.style.cssText = 'position:relative;flex:1;height:3px;border-radius:2px;background:var(--gaze-cal-track);opacity:.75';
    const mid = doc.createElement('i');
    mid.style.cssText = 'position:absolute;left:50%;top:-2px;width:1px;height:7px;background:var(--gaze-cal-ink);opacity:.45';
    const needle = doc.createElement('i');
    needle.style.cssText = [
      'position:absolute',
      'top:-3px',
      'left:50%',
      'width:3px',
      'height:9px',
      'margin-left:-1.5px',
      'border-radius:2px',
      'background:var(--gaze-cal-done)',
      'transition:left .06s linear,background .16s ease',
    ].join(';');
    bar.appendChild(mid);
    bar.appendChild(needle);
    const val = doc.createElement('span');
    val.textContent = '—';
    val.style.cssText = 'width:40px;text-align:right;font-size:9px;font-variant-numeric:tabular-nums;opacity:.85';
    row.appendChild(name);
    row.appendChild(bar);
    row.appendChild(val);
    tiltWrap.appendChild(row);
    return { ax, needle, val };
  });
  camBox.appendChild(tiltWrap);
  root.appendChild(camBox);

  /** 还没有基准头位时的通用标准框（脸高约 0.48，居中）。 */
  const STD_BOX = { x: 0.30, y: 0.26, w: 0.40, h: 0.48 };

  /** 只有两态：合格=绿，不合格=红（不留黄/黑/灰的中间态）。 */
  function toneOf(info) {
    if (!info) return 'bad';
    if (info.blink) return 'bad';
    if (!info.distanceOk || !info.centerOk) return 'bad';
    if (!info.strictOk) return 'bad';
    if (!info.poseOk) return 'bad';
    if (Math.abs(Number(info.roll)) > 12) return 'bad';
    return 'ok';
  }

  // canvas 不认 CSS 变量，这里必须是字面色值
  const CAM_TONE = {
    ok: '#46c98a',
    bad: '#ff6b6b',
  };
  const TONE_COLOR = CAM_TONE;

  /** 预览画布按真实取流宽高比伸缩；1080p 摄像头是 16:9，不能硬塞进 4:3 框。 */
  function fitCamToVideo(video) {
    const asp =
      video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const key = String(Math.round(asp * 1000));
    if (camCanvas.dataset.asp === key) return;
    camCanvas.dataset.asp = key;
    const w = camCanvas.width || (prepOn ? 320 : 236);
    const h = Math.max(1, Math.round(w / asp));
    camCanvas.height = h;
    camCanvas.style.height = h + 'px';
    camWrap.style.height = h + 'px';
  }

  function drawCam(info) {
    fitCamToVideo(info && info.video);
    const w = camCanvas.width;
    const h = camCanvas.height;
    const ctx = camCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const video = info && info.video;
    if (video && video.readyState >= 2 && video.videoWidth) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      try {
        ctx.drawImage(video, 0, 0, w, h);
      } catch (_) {
        /* 帧切换间隙画不出来就跳过这一帧 */
      }
      ctx.restore();
    } else {
      ctx.fillStyle = '#0b1512';
      ctx.fillRect(0, 0, w, h);
    }

    // 虚线标准框 = 标定开始时的头部位置（还没建立基准时用通用框）
    const rb = (info && info.refBox) || STD_BOX;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255,255,255,.62)';
    ctx.strokeRect(rb.x * w, rb.y * h, rb.w * w, rb.h * h);
    ctx.restore();

    // 实时头框
    if (info && info.box) {
      const b = info.box;
      const tone = toneOf(info);
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = TONE_COLOR[tone];
      ctx.shadowColor = TONE_COLOR[tone];
      ctx.shadowBlur = 6;
      ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h);
      ctx.restore();
    }

    // 眼线：能直接看出歪头
    if (info && info.eyes) {
      const e = info.eyes;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(116,240,206,.62)';
      ctx.beginPath();
      ctx.moveTo(e.lx * w, e.ly * h);
      ctx.lineTo(e.rx * w, e.ry * h);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 顶部胶囊上的眼睛状态点：true=已捕获、false=丢失、其它=待定。 */
  function setEyeStatus(ok) {
    if (!mounted || destroyed) return;
    eye.style.background = ok === false
      ? 'var(--gaze-cal-bad)'
      : ok
        ? 'var(--gaze-cal-done)'
        : 'var(--gaze-cal-idle)';
  }

  const BADGE_BAD = 'var(--gaze-cal-bad)';
  const BADGE_OK = 'var(--gaze-cal-done)';
  const BADGE_IDLE = 'var(--gaze-cal-idle)';

  /** 更新头控小窗。info 里可以带 video 元素，直接当预览画面。 */
  function setHead(info) {
    if (!mounted || destroyed) return;
    const data = info || null;
    lastHead = data;
    drawCam(data);

    if (!data) {
      camBadgeText.nodeValue = '未检测到人脸 · 请正对摄像头';
      camBadgeDot.style.background = BADGE_BAD;
      camBadge.style.borderColor = BADGE_BAD;
      camBox.style.borderColor = BADGE_BAD;
      for (const n of axisNodes) {
        n.needle.style.left = '50%';
        n.needle.style.background = BADGE_BAD;
        n.val.textContent = '—';
      }
      return;
    }

    const tone = toneOf(data);
    const color = tone === 'ok' ? BADGE_OK : BADGE_BAD;

    for (const n of axisNodes) {
      const v = Number(data[n.ax.key]);
      const finite = Number.isFinite(v);
      const deg = finite ? v : 0;
      const clamped = Math.max(-12, Math.min(12, deg));
      n.needle.style.left = `${50 + (clamped / 12) * 50}%`;
      n.needle.style.background = tone === 'ok' ? BADGE_OK : BADGE_BAD;
      n.val.textContent = finite ? `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°` : '—';
    }

    let text;
    if (data.blink) {
      text = '眨眼 · 请睁眼';
    } else if (!data.distanceOk) {
      const distMin = Number.isFinite(data.distMin) ? data.distMin : 0.22;
      text = data.faceH < distMin ? '太远 · 请靠近一点' : '太近 · 请稍微离远一点';
    } else if (!data.centerOk) {
      text = '请回到画面中央';
    } else if (Math.abs(Number(data.roll)) > 12) {
      text = '头歪了 · 请回正';
    } else if (!data.poseOk) {
      text = '请正对屏幕（别仰头/低头）';
    } else if (!data.strictOk) {
      text = '头位偏了 · 请对准虚线框';
    } else {
      text = prepOn ? '很好 · 保持不动，马上开始' : '头部稳定';
    }
    camBadgeText.nodeValue = text;
    camBadgeDot.style.background = color;
    camBadge.style.borderColor = color;
    camBox.style.borderColor = color;
  }

  /* ---------------- 标定前的摄像头弹窗（居中放大，头稳了才倒计时） ---------------- */

  const prepTtl = doc.createElement('div');
  prepTtl.textContent = '对准摄像头 · 把脸放进虚线框';
  prepTtl.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:calc(50% - 178px)',
    'transform:translateX(-50%)',
    'display:none',
    'padding:7px 16px',
    'border-radius:999px',
    'background:var(--gaze-cal-bg)',
    'border:1px solid var(--gaze-cal-track)',
    'color:var(--gaze-cal-ink)',
    'font-size:13px',
    'letter-spacing:.02em',
    'white-space:nowrap',
    'z-index:2',
    'pointer-events:none',
  ].join(';');
  root.appendChild(prepTtl);

  let prepOn = false;
  let lastHead = null;

  /** true = 居中大弹窗（标定前对位）；false = 右下角小窗（标定/测试中）。 */
  function setPrep(on) {
    if (!mounted || destroyed) return;
    const want = !!on;
    if (want === prepOn) return;
    prepOn = want;
    if (want) {
      camBox.style.left = '50%';
      camBox.style.top = '50%';
      camBox.style.right = 'auto';
      camBox.style.bottom = 'auto';
      camBox.style.transform = 'translate(-50%,-50%)';
      camBox.style.width = '320px';
      camBox.style.borderRadius = '16px';
      camWrap.style.width = '320px';
      camCanvas.width = 320;
      camCanvas.style.width = '320px';
      prepTtl.style.display = 'block';
    } else {
      camBox.style.left = '';
      camBox.style.top = '';
      camBox.style.right = '16px';
      camBox.style.bottom = '16px';
      camBox.style.transform = '';
      camBox.style.width = '236px';
      camBox.style.borderRadius = '12px';
      camWrap.style.width = '236px';
      camCanvas.width = 236;
      camCanvas.style.width = '236px';
      prepTtl.style.display = 'none';
    }
    camCanvas.dataset.asp = '';
    fitCamToVideo(lastHead && lastHead.video);
    drawCam(lastHead);
  }

  // 取消按钮：标定占满整屏时，鼠标用户也需要一个明确的出口
  const close = doc.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '回到首页');
  close.textContent = '回到首页';
  close.style.cssText = [
    'position:absolute',
    'right:16px',
    'top:14px',
    'height:32px',
    'padding:0 14px',
    'border-radius:999px',
    'border:1px solid var(--gaze-cal-track)',
    'background:var(--gaze-cal-bg)',
    'color:var(--gaze-cal-ink)',
    'font:13px/1 system-ui,sans-serif',
    'letter-spacing:.02em',
    'cursor:pointer',
    'pointer-events:auto',
    'display:none',
  ].join(';');
  close.addEventListener('click', () => {
    if (onCancel) onCancel();
  });
  root.appendChild(close);

  const dots = pts.map((p, i) => {
    const dot = doc.createElement('div');
    dot.dataset.i = String(i);
    dot.style.cssText = [
      'position:absolute',
      'width:32px',
      'height:32px',
      'margin:-16px 0 0 -16px',
      'border-radius:50%',
      'border:2px solid var(--gaze-cal-idle)',
      'background:transparent',
      'box-sizing:border-box',
      'z-index:3',
      'transition:border-color .12s ease,box-shadow .12s ease,transform .12s ease',
    ].join(';');

    const ring = doc.createElement('span');
    ring.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'width:52px',
      'height:52px',
      'margin:-26px 0 0 -26px',
      'border-radius:50%',
      'border:2px solid var(--gaze-cal-accent)',
      'opacity:0',
      'pointer-events:none',
    ].join(';');
    dot.appendChild(ring);

    const fill = doc.createElement('span');
    fill.style.cssText = [
      'position:absolute',
      'inset:-2px',
      'border-radius:50%',
      'background:conic-gradient(from -90deg, var(--gaze-cal-accent) calc(var(--p,0) * 1turn), rgba(255,255,255,.08) 0)',
      '-webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 5px))',
      'mask:radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 5px))',
      'opacity:0',
      'transition:opacity .12s ease',
      'pointer-events:none',
    ].join(';');
    dot.appendChild(fill);

    const core = doc.createElement('span');
    core.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'width:8px',
      'height:8px',
      'margin:-4px 0 0 -4px',
      'border-radius:50%',
      'background:var(--gaze-cal-idle)',
      'transition:background .12s ease',
    ].join(';');
    dot.appendChild(core);

    root.appendChild(dot);
    return { dot, ring, fill, core, p };
  });

  // 鼠标辅助：只有「等待点击」的当前点接收指针事件，其余点保持穿透
  dots.forEach((item, i) => {
    item.dot.style.pointerEvents = 'none';
    item.dot.setAttribute('role', 'button');
    item.dot.setAttribute('aria-label', `标定点 ${i + 1}`);
    item.dot.addEventListener('pointerdown', (e) => {
      if (item.dot.style.pointerEvents === 'none') return;
      e.preventDefault();
      e.stopPropagation();
      if (onPointClick) onPointClick(i);
    });
  });

  /**
   * 实时视线落点。标定途中没有模型时由调用方喂「增量拟合」的预测，
   * 校验阶段喂最终模型的预测——用户全程都能看到系统认为他在看哪。
   */
  const cursor = doc.createElement('div');
  cursor.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'width:24px',
    'height:24px',
    'margin:-12px 0 0 -12px',
    'opacity:0',
    'transition:opacity .18s ease',
    'pointer-events:none',
    'will-change:transform',
    '--cc:#eef6ef',
    'filter:drop-shadow(0 0 3px rgba(0,0,0,.85))',
  ].join(';');
  const cursorH = doc.createElement('i');
  cursorH.style.cssText = 'position:absolute;left:1px;top:11px;width:22px;height:1.5px;background:var(--cc);border-radius:1px';
  const cursorV = doc.createElement('i');
  cursorV.style.cssText = 'position:absolute;left:11px;top:1px;width:1.5px;height:22px;background:var(--cc);border-radius:1px';
  const cursorCore = doc.createElement('span');
  cursorCore.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    'width:5px',
    'height:5px',
    'margin:-2.5px 0 0 -2.5px',
    'border-radius:50%',
    'background:var(--cc)',
  ].join(';');
  cursor.appendChild(cursorH);
  cursor.appendChild(cursorV);
  cursor.appendChild(cursorCore);
  root.appendChild(cursor);

  const result = doc.createElement('div');
  result.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    'transform:translate(-50%,-50%)',
    'padding:18px 22px',
    'border-radius:14px',
    'background:var(--gaze-cal-bg)',
    'color:var(--gaze-cal-ink)',
    'font-size:14px',
    'line-height:1.6',
    'text-align:center',
    'white-space:pre-line',
    'display:none',
    'pointer-events:none',
    'backdrop-filter:blur(8px)',
  ].join(';');
  root.appendChild(result);

  let currentIdx = 0;
  let counting = false;
  const cdResolvers = new Set();

  /** 当前靶点是否落在右下小窗区域（是则让小窗淡出，别挡住点）。 */
  function currentDotInCam() {
    const it = dots[currentIdx];
    if (!it) return false;
    const vw = (win && win.innerWidth) || 1280;
    const vh = (win && win.innerHeight) || 800;
    const x = it.p.tx * vw;
    const y = it.p.ty * vh;
    return x > vw - 290 && y > vh - 270;
  }

  /* 居中倒计时：3-2-1，标定与测试开始前各一次 */
  const cd = doc.createElement('div');
  cd.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    'transform:translate(-50%,-50%)',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'width:180px',
    'height:180px',
    'border-radius:50%',
    'background:var(--gaze-cal-bg)',
    'border:1px solid var(--gaze-cal-track)',
    'color:var(--gaze-cal-accent)',
    'font:600 92px/1 system-ui,sans-serif',
    'letter-spacing:0',
    'box-shadow:0 0 60px rgba(169,219,123,.25)',
    'backdrop-filter:blur(10px)',
    'pointer-events:none',
    'will-change:transform,opacity',
  ].join(';');
  root.appendChild(cd);

  const cdHint = doc.createElement('div');
  cdHint.textContent = '坐正，盯住即将出现的圆点';
  cdHint.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:calc(50% + 116px)',
    'transform:translateX(-50%)',
    'font-size:13px',
    'letter-spacing:.03em',
    'color:var(--gaze-cal-track)',
    'display:none',
    'white-space:nowrap',
    'pointer-events:none',
  ].join(';');
  root.appendChild(cdHint);

  /**
   * 3-2-1 倒计时。返回的 Promise 在倒计时结束后 resolve。
   * 倒计时期间靶点保持可见（用户要求：倒计时/点间停顿都不许消失）。
   */
  function countdown(from = 3, ms = 760, hint = '坐正，盯住即将出现的圆点') {
    return new Promise((resolve) => {
      if (!mounted || destroyed) {
        resolve();
        return;
      }
      counting = true;
      cdResolvers.add(resolve);
      // 摄像头弹窗居中时，倒计时放在弹窗下方，不压住人脸预览
      cd.style.top = prepOn ? 'calc(50% + 212px)' : '50%';
      cdHint.style.top = prepOn ? 'calc(50% + 328px)' : 'calc(50% + 116px)';
      cdHint.textContent = hint;
      cdHint.style.display = 'block';
      cd.style.display = 'flex';
      hudText.nodeValue = '准备开始';
      let n = Math.max(1, Number(from) || 3);
      const tick = () => {
        if (destroyed) {
          counting = false;
          resolve();
          return;
        }
        if (n <= 0) {
          cd.style.display = 'none';
          cdHint.style.display = 'none';
          counting = false;
          cdResolvers.delete(resolve);
          resolve();
          return;
        }
        cd.textContent = String(n);
        if (typeof cd.animate === 'function') {
          cd.animate(
            [
              { transform: 'translate(-50%,-50%) scale(.62)', opacity: 0.2 },
              { transform: 'translate(-50%,-50%) scale(1.06)', opacity: 1 },
              { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
            ],
            { duration: Math.max(180, ms - 120), easing: 'ease-out' },
          );
        }
        n -= 1;
        setTimer(tick, ms);
      };
      tick();
    });
  }

  let mounted = false;
  let destroyed = false;
  let escHandler = null;
  let relayout = null;

  /**
   * 靶点定位取「容器 ∩ 视口」。
   *
   * root 是 position:fixed，坐标原点在视口左上角；如果容器比视口高（页面可滚动），
   * 直接用容器 rect 会把最后一排靶点放到视口外，用户只看到 6 个点、也点不到它们。
   */
  function layout() {
    const win = doc.defaultView || { innerWidth: 1280, innerHeight: 800 };
    const r = container && container.getBoundingClientRect
      ? container.getBoundingClientRect()
      : { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight, width: win.innerWidth, height: win.innerHeight };
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, win.innerWidth);
    const bottom = Math.min(r.bottom, win.innerHeight);
    const w = Math.max(right - left, 1);
    const h = Math.max(bottom - top, 1);
    for (const item of dots) {
      item.dot.style.left = `${Math.round(left + item.p.tx * w)}px`;
      item.dot.style.top = `${Math.round(top + item.p.ty * h)}px`;
    }
  }

  function setTimer(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function mount(opts = {}) {
    if (mounted || destroyed) return;
    doc.body.appendChild(root);
    mounted = true;
    close.style.display = opts.cancelable === false ? 'none' : 'block';
    layout();

    // 容器尺寸/滚动位置变化都要重算，否则靶点会和画面对不上
    relayout = () => layout();
    window.addEventListener('resize', relayout);
    window.addEventListener('scroll', relayout, { passive: true });

    escHandler = (e) => {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) {
        e.preventDefault();
        if (onCancel) onCancel();
      }
    };
    doc.addEventListener('keydown', escHandler, true);
    if (win && win !== doc) win.addEventListener('keydown', escHandler, true);
  }

  /**
   * @param {{phase?:string, idx?:number, progress?:number, note?:string, total?:number}} state
   */
  let gapFlashFor = -1;

  /** 点间 1 秒：下一个点外圈闪两下，提示「马上从这里开始」。 */
  function flashDot(i) {
    const item = dots[i];
    if (!item || !item.ring) return;
    const ring = item.ring;
    try {
      if (ring.__anim) ring.__anim.cancel();
      ring.__anim = ring.animate(
        [
          { opacity: 0, transform: 'scale(.84)' },
          { opacity: 1, transform: 'scale(1.04)', offset: 0.1 },
          { opacity: 0, transform: 'scale(1.16)', offset: 0.22 },
          { opacity: 0, transform: 'scale(.84)', offset: 0.62 },
          { opacity: 1, transform: 'scale(1.04)', offset: 0.72 },
          { opacity: 0, transform: 'scale(1.16)', offset: 0.84 },
          { opacity: 0, transform: 'scale(.84)', offset: 1 },
        ],
        { duration: 1000, easing: 'ease-out' },
      );
    } catch (e) {
      /* 不支持 WAAPI 时静默跳过，倒计时文案仍在 */
    }
  }

  function update(state = {}) {
    if (!mounted || destroyed) return;
    layout();

    const phase = state.phase || 'settle';
    const idx = Number.isInteger(state.idx) ? state.idx : 0;
    const progress = Math.max(0, Math.min(1, Number(state.pointProgress != null ? state.pointProgress : state.progress) || 0));
    const done = phase === 'result';
    const gap = Math.max(0, Number(state.gap) || 0);
    currentIdx = idx;
    if (gap > 0 && !counting && !done) {
      if (gapFlashFor !== idx) {
        gapFlashFor = idx;
        flashDot(idx);
      }
    } else if (gap <= 0) {
      gapFlashFor = -1;
    }

    dots.forEach((item, i) => {
      const isDone = done || i < idx;
      const isCurrent = !done && i === idx;
      item.dot.style.borderColor = isDone
        ? 'var(--gaze-cal-done)'
        : isCurrent
          ? 'var(--gaze-cal-accent)'
          : 'var(--gaze-cal-idle)';
      item.core.style.background = isDone
        ? 'var(--gaze-cal-done)'
        : isCurrent
          ? 'var(--gaze-cal-accent)'
          : 'var(--gaze-cal-idle)';
      // 当前靶点放大到 54px（32 × 1.6），与 air-runner 的 .gc-point.cur 一致
      item.dot.style.boxShadow = isCurrent ? '0 0 26px rgba(169,219,123,0.5)' : 'none';
      item.dot.style.transform = isCurrent ? 'scale(1.6)' : 'scale(1)';
      item.fill.style.opacity = isCurrent ? '1' : '0';
      item.dot.style.setProperty('--p', isCurrent ? String(progress) : '0');
      // 注视即采样，靶点全程穿透，不再需要鼠标点击
      item.dot.style.pointerEvents = 'none';
      item.dot.style.cursor = 'default';
      // 倒计时、点间停顿都不隐藏靶点
      item.dot.style.visibility = 'visible';
    });

    const REASON_TEXT = {
      noFace: '未检测到人脸 · 请正对摄像头',
      blink: '眨眼 · 该帧已丢弃',
      head: '头位偏离 · 该帧已丢弃',
      weak: '有效帧偏少 · 已按现有数据记录',
      jitter: '视线晃动 · 该帧已丢弃',
      noGaze: '没检测到视线移动 · 该点已跳过',
      stale: '摄像头没有新画面 · 等画面恢复',
    };
    if (counting) {
      /* 倒计时自己管顶部文案 */
    } else if (gap > 0) {
      hudText.nodeValue = `下一个点 · ${Math.ceil(gap / 100) / 10}s`;
    } else if (state.reason && REASON_TEXT[state.reason]) hudText.nodeValue = REASON_TEXT[state.reason];
    else if (state.note === 'waiting-face') hudText.nodeValue = '未检测到人脸 · 请正对摄像头';
    else if (state.note) hudText.nodeValue = String(state.note);
    else if (!done) hudText.nodeValue = `${label} · ${Math.min(idx + 1, pts.length)} / ${pts.length}`;
  }

  /** 实时视线落点，参数是页面归一化坐标（0..1）。 */
  function setCursor(x, y, opts = {}) {
    if (!mounted || destroyed) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      hideCursor();
      return;
    }
    const vw = (win && win.innerWidth) || 1;
    const vh = (win && win.innerHeight) || 1;
    cursor.style.transform = `translate3d(${x * vw}px, ${y * vh}px, 0)`;
    cursor.style.opacity = opts.rough ? '0.75' : '1';
    const color = opts.bad ? '#ff6b6b' : opts.rough ? '#aabf91' : '#eef6ef';
    cursor.style.setProperty('--cc', color);
  }

  function hideCursor() {
    cursor.style.opacity = '0';
  }

  /** 完成态：显示汇总；传 error 时用 bad 色。 */
  function showResult(payload = {}) {
    if (!mounted || destroyed) return;
    const ok = payload.ok !== false;
    result.style.display = 'block';
    result.style.color = ok ? 'var(--gaze-cal-ink)' : 'var(--gaze-cal-bad)';
    result.textContent = payload.text || (ok ? '标定完成' : '标定失败');
    hudText.nodeValue = payload.hud || (ok ? '标定完成' : '标定失败');
    dots.forEach((item) => {
      item.dot.style.borderColor = ok ? 'var(--gaze-cal-done)' : 'var(--gaze-cal-bad)';
      item.core.style.background = ok ? 'var(--gaze-cal-done)' : 'var(--gaze-cal-bad)';
      item.fill.style.opacity = '0';
      item.dot.style.boxShadow = 'none';
      item.dot.style.transform = 'scale(1)';
    });

    if (payload.autoHideMs) {
      setTimer(() => hideResult(), Number(payload.autoHideMs));
    }
  }

  function hideResult() {
    result.style.display = 'none';
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    // 倒计时进行中被销毁（例如点「回到首页」）：让 await 方立刻恢复，避免悬挂
    for (const fn of cdResolvers) {
      try { fn(); } catch (e) {}
    }
    cdResolvers.clear();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    if (escHandler) {
      doc.removeEventListener('keydown', escHandler, true);
      if (win && win !== doc) win.removeEventListener('keydown', escHandler, true);
      escHandler = null;
    }
    if (relayout) {
      window.removeEventListener('resize', relayout);
      window.removeEventListener('scroll', relayout);
      relayout = null;
    }
    if (root.parentNode) root.parentNode.removeChild(root);
    mounted = false;
  }

  return {
    root,
    mount,
    update,
    countdown,
    showResult,
    hideResult,
    layout,
    setCursor,
    hideCursor,
    setEyeStatus,
    setHead,
    setPrep,
    destroy,
  };
}

export default createOverlay;

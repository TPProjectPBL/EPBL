/**
 * @file 统一标定状态机（真实采样，不做动画假标定）。
 *
 * 流程：
 *   ready(3-2-1) → calib(9 点，点间停 1s) → fit → ready(3-2-1) → validate(5 点) → result
 *
 * 两个阶段的严格程度不同：
 *   - 标定：只有「有效帧」累计满 1000ms 才结算；无脸/眨眼/头位不合格/画面停流
 *     都会把当前点清零重来。头位门槛完全沿用 gaze-heatmap 融合前版本
 *     （距离 0.22~0.80、居中 0.17/0.20、roll 12°、yaw 17°、pitch 5~68°，
 *      相对基准位移 0.055/0.065/0.10、角度 5°/7°/8°），不再用单一 10° 硬阈值。
 *   - 测试（验证）：固定 1 秒墙钟窗口，不稳定只丢帧、**不重来**；1 秒到就按
 *     已采到的有效帧评分，没采到就记满误差。这样测出来的是真实准确率，
 *     而不是「谁不抖谁分数高」。
 *
 * 状态机本身不碰 DOM、不碰摄像头、不开定时器：调用方每帧调用 update(now)，
 * 并实现 getLandmarks()。这样标定循环与页面的渲染/推理循环共用一条时钟。
 */

import { headGate, headPose, toHeadRef } from '../head.js';
import { HEAD_VALIDATE } from '../contract.js';
import { extractFeatures } from '../core/index.js';
import { mirrorLandmarks } from '../core/mirror.js';
import {
  CALIB_POINTS,
  EAR_MIN,
  FRAME_DT_MAX_MS,
  FRAME_OUTLIER_MAX,
  FRAME_STALE_MS,
  GAZE_JITTER_MAX,
  MIN_FRAMES,
  MIN_GAZE_DELTA,
  PASS_SCORE,
  PHASE,
  POINT_GAP_MS,
  POINT_MIN_SAMPLE_FRAMES,
  POINT_TIMEOUT_MS,
  READY_REF_STREAK,
  READY_STABLE_STREAK,
  RESET_REASON,
  RIDGE_ALPHA,
  SAMPLE_MS,
  SCORE_SPAN,
  STD_ALIGN,
  STD_HEAD,
  stdBoxOf,
  VALIDATE_EXTEND_MAX,
  VALIDATE_EXTEND_MS,
  VALIDATE_POINTS,
  scoreOf,
  toPoints,
} from './protocol.js';
import { fitPoly2, pointError } from './poly2.js';

/** 窗口内有效帧的特征平均。 */
function averageFeatures(list) {
  if (!list || !list.length) return null;
  const keys = Object.keys(list[0]);
  const out = {};
  for (const k of keys) {
    let sum = 0;
    for (const f of list) sum += f[k];
    out[k] = sum / list.length;
  }
  return out;
}

/** 窗口内某项特征的标准差（用于「视线是否在游走」）。 */
function stdOf(list, key) {
  if (list.length < 2) return 0;
  let m = 0;
  for (const f of list) m += f[key];
  m /= list.length;
  let s = 0;
  for (const f of list) s += (f[key] - m) * (f[key] - m);
  return Math.sqrt(s / (list.length - 1));
}

/** 人脸框（归一化坐标，已镜像）。 */
function boxOf(head) {
  if (!head) return null;
  return {
    x: head.cx - head.faceW / 2,
    y: head.cy - head.faceH / 2,
    w: head.faceW,
    h: head.faceH,
  };
}

/**
 * 当前头位是否对准了固定标准框（画面居中 + 脸高接近 STD_HEAD.faceH）。
 * 这是标定前的对齐门槛：用户先把脸调进来，才允许锁定基准、开始倒计时。
 */
export function alignedToStd(head) {
  if (!head || !Number.isFinite(head.cx) || !Number.isFinite(head.cy) || !Number.isFinite(head.faceH)) {
    return false;
  }
  return Math.abs(head.cx - STD_HEAD.cx) <= STD_ALIGN.cx &&
    Math.abs(head.cy - STD_HEAD.cy) <= STD_ALIGN.cy &&
    head.faceH >= STD_ALIGN.faceHMin && head.faceH <= STD_ALIGN.faceHMax;
}

/**
 * 头控 HUD 用的实时头位信息：
 * 绝对头位 + 相对基准的位移/角度 + 标准框与当前框，UI 直接照着画。
 */
function headInfo(head, ref, aspect) {
  if (!head) return null;
  const gate = headGate(head, ref);
  const d = gate.delta || {};
  return {
    ok: !!head.ok,
    strictOk: !!gate.strictOk,
    blink: !!head.blink,
    ear: Number.isFinite(head.ear) ? head.ear : NaN,
    roll: head.roll,
    yaw: head.yaw,
    pitch: head.pitch,
    cx: head.cx,
    cy: head.cy,
    faceW: head.faceW,
    faceH: head.faceH,
    distMin: head.distMin,
    distMax: head.distMax,
    distanceOk: !!head.distanceOk,
    centerOk: !!head.centerOk,
    poseOk: !!head.poseOk,
    dx: d.dx || 0,
    dy: d.dy || 0,
    dh: d.dh || 0,
    dRoll: d.dRoll || 0,
    dYaw: d.dYaw || 0,
    dPitch: d.dPitch || 0,
    hasRef: !!ref,
    stdOk: alignedToStd(head),
    box: boxOf(head),
    // 虚线框永远是固定标准框，不再取第一个头位当靶子（那样框跟着人跑，无从对齐）
    refBox: stdBoxOf(aspect),
  };
}

/**
 * @param {object} opts
 * @param {() => Array|null} opts.getLandmarks 当前帧关键点（未镜像）
 * @param {() => number} [opts.getAspect]
 * @param {() => number} [opts.getFrameId] 新帧序号；同一序号不推进进度
 * @param {() => number} [opts.getFrameAge] 距上一帧的毫秒数
 * @param {(st:object)=>void} [opts.onUpdate]
 * @param {(model:object, report:object)=>void} [opts.onDone]
 * @param {(report:object)=>void} [opts.onReview]
 * @param {(report:object)=>void} [opts.onFail]
 */
export function createSession(opts = {}) {
  const points = toPoints(CALIB_POINTS);
  const validatePoints = toPoints(VALIDATE_POINTS);
  const sampleMs = Number(opts.sampleMs) || SAMPLE_MS;
  const minFrames = Number(opts.minFrames) || MIN_FRAMES;
  const getLandmarks = opts.getLandmarks || (() => null);
  const getAspect = opts.getAspect || (() => 4 / 3);
  // 离线合成脸测试可关掉「人脸尺寸/居中/标准框对齐」门控；真实运行始终开启
  const faceGate = opts.faceGate !== false;
  const stdGate = opts.stdGate !== false;

  const S = {
    phase: PHASE.IDLE,
    active: false,
    paused: false,
    /** 倒计时结束后要进入的阶段 */
    next: PHASE.CALIB,
    idx: 0,
    frames: [],
    samples: [],
    acc: 0,
    prevFrameAt: 0,
    lastFrameId: -1,
    head: null,
    resetAt: 0,
    ref: null,
    gapUntil: 0,
    note: '',
    reason: '',
    lastNow: 0,
    model: null,
    report: null,
    valIdx: 0,
    valErrors: [],
    valPointsResult: [],
    valStart: 0,
    valDropped: 0,
    valDropReasons: {},
    /** 当前验证点已延长的时间（帧数不足时最多累计到 VALIDATE_EXTEND_MAX） */
    valExtra: 0,
    startedAt: 0,
    /** READY 阶段已消费到的帧序号（去重用） */
    readyFrameId: -1,
    /** READY（摄像头弹窗）阶段的连续合格帧数 */
    readyStreak: 0,
    /** READY 阶段是否已经「头稳住」→ 可以开始倒计时 */
    ready: false,
    /** 当前点开始计时的时间（墙钟兜底用） */
    pointStart: 0,
  };

  function emit() {
    if (!opts.onUpdate) return;
    opts.onUpdate({
      phase: S.phase,
      next: S.next,
      idx: S.phase === PHASE.VALIDATE ? S.valIdx : S.idx,
      total: S.phase === PHASE.VALIDATE ? validatePoints.length : points.length,
      pointProgress: localProgress(),
      progress: totalProgress(),
      gap: gapLeft(),
      note: S.note,
      reason: S.reason,
      head: S.head,
      ready: !!S.ready,
      readyStreak: S.readyStreak,
      avgDist: S.report ? S.report.avgDist : null,
      score: S.report ? S.report.score : null,
      frames: S.frames.length,
      samples: S.samples.length,
      report: S.report,
    });
  }

  /** 点间停顿剩余时间（ms）。> 0 时不采样，但靶点照常显示。 */
  function gapLeft() {
    if (!S.gapUntil || !S.lastNow) return 0;
    return Math.max(0, S.gapUntil - S.lastNow);
  }

  /** 进度 = 已累计的有效帧时长 / 采样窗口；没有有效帧时恒为 0。 */
  function localProgress() {
    if (S.phase === PHASE.CALIB) {
      if (gapLeft() > 0) return 0;
      return Math.min(1, S.acc / sampleMs);
    }
    if (S.phase === PHASE.VALIDATE) {
      if (!S.valStart || !S.lastNow) return 0;
      // 窗口可能被延长：进度条跟着「当前总窗口」走，延长后不会瞬间冲到 100%
      return Math.min(1, (S.lastNow - S.valStart) / (sampleMs + S.valExtra));
    }
    return 0;
  }

  function totalProgress() {
    if (S.phase === PHASE.CALIB) return (S.idx + localProgress()) / points.length;
    if (S.phase === PHASE.VALIDATE) {
      return (S.valIdx + localProgress()) / validatePoints.length;
    }
    if (S.phase === PHASE.RESULT) return 1;
    return 0;
  }

  /** 本点作废：累计时长与已采帧立刻清零，环立即回到起点。 */
  function resetSegment(reason, now) {
    S.acc = 0;
    S.frames = [];
    S.reason = reason;
    S.note = RESET_REASON[reason] || reason;
    S.resetAt = now || S.lastNow || 0;
  }

  /** 开始（倒计时阶段）。已有进度时用 resume() 继续。 */
  function start() {
    S.phase = PHASE.READY;
    S.next = PHASE.CALIB;
    S.active = true;
    S.paused = false;
    S.idx = 0;
    S.frames = [];
    S.samples = [];
    S.acc = 0;
    S.prevFrameAt = 0;
    S.lastFrameId = -1;
    S.head = null;
    S.resetAt = 0;
    S.gapUntil = 0;
    S.ref = null;
    S.note = '准备开始';
    S.reason = '';
    S.model = null;
    S.report = null;
    S.valIdx = 0;
    S.valErrors = [];
    S.valPointsResult = [];
    S.valStart = 0;
    S.valDropped = 0;
    S.valDropReasons = {};
    S.valExtra = 0;
    S.startedAt = Date.now();
    S.readyStreak = 0;
    S.ready = false;
    S.readyFrameId = -1;
    S.pointStart = 0;
    emit();
    return state();
  }

  /** 倒计时结束：真正开始采样。 */
  function go(now) {
    if (S.phase !== PHASE.READY) return state();
    S.lastNow = now || S.lastNow || 0;
    S.phase = S.next || PHASE.CALIB;
    S.frames = [];
    S.acc = 0;
    S.prevFrameAt = 0;
    S.lastFrameId = -1;
    S.gapUntil = 0;
    S.reason = '';
    S.note = '';
    S.ready = false;
    if (S.phase === PHASE.VALIDATE) {
      S.valStart = S.lastNow;
      S.valExtra = 0;
      S.note = '测试 5 个点 · 每个 1 秒';
    } else {
      S.pointStart = S.lastNow;
    }
    emit();
    return state();
  }

  /** 暂停（回到首页）：保留已完成的点，不清样本。 */
  function pause() {
    S.paused = true;
    emit();
  }

  /** 继续：从当前点、当前采样窗口重新开始。 */
  function resume(now) {
    S.paused = false;
    S.lastNow = now || S.lastNow || 0;
    S.acc = 0;
    S.frames = [];
    S.prevFrameAt = 0;
    S.lastFrameId = -1;
    S.gapUntil = 0;
    S.reason = '';
    S.ready = false;
    if (S.phase === PHASE.VALIDATE) {
      S.valStart = S.lastNow;
      S.valExtra = 0;
    } else if (S.phase === PHASE.READY) {
      S.readyStreak = 0;
      S.readyFrameId = -1;
    }
    else S.pointStart = S.lastNow;
    emit();
    return state();
  }

  function abort() {
    S.active = false;
    S.paused = false;
    S.phase = PHASE.IDLE;
    S.frames = [];
    S.acc = 0;
    S.gapUntil = 0;
    S.note = '';
    S.ready = false;
    S.readyStreak = 0;
    S.pointStart = 0;
    emit();
  }

  /**
   * READY（摄像头弹窗）阶段：只判断「头对准标准框且稳不稳」，不采样。
   *
   * 固定标准框（STD_HEAD：居中 + 脸高约 0.48）是**靶子**，用户要主动把脸调进去。
   * 只有对齐 + 姿态合格 + 不眨眼，才累计稳定帧；连续 READY_REF_STREAK 帧后锁定
   * 基准头位（此时取的是「对齐后」的头位，不是第一个坐姿），再连续到
   * READY_STABLE_STREAK 帧才允许倒计时。虚线框全程画固定 STD_HEAD，不随头移动。
   */
  function updateReady() {
    // 同一帧被 rAF 和兜底定时器重复调用时不能重复累计「稳定帧数」
    const fid = typeof opts.getFrameId === 'function' ? Number(opts.getFrameId()) : NaN;
    if (Number.isFinite(fid) && fid >= 0 && fid === S.readyFrameId) return;
    if (Number.isFinite(fid) && fid >= 0) S.readyFrameId = fid;

    const raw = getLandmarks();
    const lm = raw ? mirrorLandmarks(raw) : null;
    const head = lm ? headPose(lm, { aspect: getAspect() }) : null;
    const usable = head && (!faceGate || (head.distanceOk && head.centerOk)) ? head : null;
    const blink = !!(head && Number.isFinite(head.ear) && head.ear < EAR_MIN);
    const stdOk = !stdGate || alignedToStd(usable);
    const ok = !!(usable && usable.ok && !blink && stdOk);

    S.readyStreak = ok ? S.readyStreak + 1 : 0;
    if (ok && !S.ref && S.readyStreak >= READY_REF_STREAK) S.ref = toHeadRef(usable);

    const gate = usable ? headGate(usable, S.ref) : null;
    S.head = usable ? headInfo(usable, S.ref, getAspect()) : null;
    S.ready = !!(ok && S.ref && gate && gate.strictOk && S.readyStreak >= READY_STABLE_STREAK);
    if (!stdOk) {
      S.reason = '';
      S.note = '请把脸移进虚线框：居中，调整远近让脸框贴住虚线框';
    } else if (!ok) {
      S.reason = '';
      S.note = '脸已进框 · 请正对屏幕、睁眼保持不动';
    } else if (S.ready) {
      S.reason = '';
      S.note = '头位已对齐标准框 · 马上开始';
    } else {
      S.reason = '';
      S.note = '保持住，正在确认头位';
    }
    emit();
  }

  /**
   * 每帧调用一次。
   *
   * 标定：只有新的一帧画面才推进进度；不稳定只丢帧，进度不会回落、不会重来。
   * 测试：固定 1 秒墙钟窗口，不稳定只丢帧。
   *
   * @param {number} now performance.now()
   */
  function update(now) {
    S.lastNow = now;
    if (!S.active || S.paused) return state();

    if (S.phase === PHASE.READY) {
      updateReady();
      return state();
    }
    if (S.phase !== PHASE.CALIB && S.phase !== PHASE.VALIDATE) return state();

    // 点间停顿（标定 / 测试通用）：不采样，靶点保持可见
    if (S.gapUntil) {
      if (now < S.gapUntil) {
        emit();
        return state();
      }
      S.gapUntil = 0;
      S.prevFrameAt = now;
      S.lastFrameId = -1;
      if (S.phase === PHASE.VALIDATE) {
        S.valStart = now;
        S.valExtra = 0;
      } else if (!S.pointStart) S.pointStart = now;
    }

    // 摄像头是否还在出新画面：必须在帧去重之前判断。
    // 停流时不推进，但也不清空已经采到的帧。
    const age = typeof opts.getFrameAge === 'function' ? Number(opts.getFrameAge()) : 0;
    if (Number.isFinite(age) && age > FRAME_STALE_MS) {
      S.reason = 'stale';
      S.note = RESET_REASON.stale;
      if (S.phase === PHASE.VALIDATE) {
        S.valDropped += 1;
        S.valDropReasons.stale = (S.valDropReasons.stale || 0) + 1;
      }
      emit();
      return state();
    }

    // 只消费「新帧」
    const fid = typeof opts.getFrameId === 'function' ? Number(opts.getFrameId()) : NaN;
    if (Number.isFinite(fid) && fid >= 0) {
      if (fid === S.lastFrameId) return state();
      S.lastFrameId = fid;
    } else if (S.prevFrameAt && now - S.prevFrameAt < 8) {
      return state();
    }

    // 单帧最多计 FRAME_DT_MAX_MS，掉帧/卡顿不会凭空补时间
    const dt = S.prevFrameAt
      ? Math.max(0, Math.min(FRAME_DT_MAX_MS, now - S.prevFrameAt))
      : 0;
    S.prevFrameAt = now;

    const raw = getLandmarks();
    const lm = raw ? mirrorLandmarks(raw) : null;
    const head = lm ? headPose(lm, { aspect: getAspect() }) : null;
    S.head = headInfo(head, S.ref, getAspect());

    // 测试：时间到就结算；但有效帧太少时先延长窗口（有上限），避免「0 帧 0 分」的假象
    if (S.phase === PHASE.VALIDATE && S.valStart && now - S.valStart >= sampleMs + S.valExtra) {
      // 正常 1 秒约 60 帧；不足 MIN_FRAMES 帧说明门控拦掉太多，值得再等
      const enough = S.frames.length >= MIN_FRAMES;
      if (enough || S.valExtra >= VALIDATE_EXTEND_MAX) {
        finishValidatePoint();
        emit();
        return state();
      }
      // 帧不够：再给一段时间，进度条按新窗口计算，最多累计到上限
      S.valExtra = Math.min(VALIDATE_EXTEND_MAX, S.valExtra + VALIDATE_EXTEND_MS);
      S.note = `有效帧偏少 · 采样延长至 ${((sampleMs + S.valExtra) / 1000).toFixed(1)}s`;
      emit();
      return state();
    }

    // ---------- 各类不合格：一律只丢这一帧，进度不回落 ----------
    const drop = (reason) => {
      S.reason = reason;
      S.note = RESET_REASON[reason] || '';
      if (S.phase === PHASE.VALIDATE) {
        S.valDropped += 1;
        S.valDropReasons[reason] = (S.valDropReasons[reason] || 0) + 1;
      }
      emit();
      return state();
    };

    if (!lm || !head) {
      S.head = null;
      return drop('noFace');
    }
    if (faceGate && (!head.distanceOk || !head.centerOk)) return drop('noFace');
    if (Number.isFinite(head.ear) && head.ear < EAR_MIN) return drop('blink');

    // 基准头位：全程固定一个（READY 弹窗里已定；这里兜底），标准框不漂
    if (!S.ref) S.ref = toHeadRef(head);
    S.head = headInfo(head, S.ref, getAspect());

    // 验证阶段放宽「相对基准」偏移：看边缘靶点头会自然转动，不该整秒判 head 丢弃
    const headLimits = S.phase === PHASE.VALIDATE ? HEAD_VALIDATE : undefined;
    const gate = headGate(head, S.ref, headLimits);
    if (!gate.strictOk) return drop('head');

    const aspect = getAspect();
    const f = extractFeatures(lm, aspect);
    if (!f) return drop('noFace');

    // 单帧离群 / 视线游走：只丢这一帧
    const mean = S.frames.length >= 4 ? averageFeatures(S.frames) : null;
    if (mean && Math.hypot(f.dLx - mean.dLx, f.dLy - mean.dLy) > FRAME_OUTLIER_MAX) {
      S.note = '视线跳变 · 该帧已丢弃';
      if (S.phase === PHASE.VALIDATE) S.valDropReasons.outlier = (S.valDropReasons.outlier || 0) + 1;
      emit();
      return state();
    }
    if (S.frames.length >= 6) {
      const jitter = Math.hypot(stdOf(S.frames, 'dLx'), stdOf(S.frames, 'dLy'));
      if (jitter > GAZE_JITTER_MAX) {
        S.note = '视线晃动 · 该帧已丢弃';
        if (S.phase === PHASE.VALIDATE) S.valDropReasons.jitter = (S.valDropReasons.jitter || 0) + 1;
        emit();
        return state();
      }
    }

    S.frames.push(f);
    S.reason = '';
    S.note = '';
    if (!S.pointStart) S.pointStart = now;

    if (S.phase === PHASE.CALIB) {
      S.acc += dt;
      // 单点墙钟兜底：头一直不稳也不会卡在这一点
      const timedOut = S.pointStart && now - S.pointStart >= POINT_TIMEOUT_MS;
      if (S.acc >= sampleMs || timedOut) {
        finishCalibPoint();
        emit();
        return state();
      }
    }

    emit();
    return state();
  }

  /** 结算当前标定点：不重来，帧不够就按已有帧记录或跳过。 */
  function finishCalibPoint() {
    const p = points[S.idx];
    const n = S.frames.length;
    const f = n >= POINT_MIN_SAMPLE_FRAMES ? averageFeatures(S.frames) : null;
    S.frames = [];
    S.acc = 0;
    S.pointStart = 0;

    if (!f) {
      S.idx += 1;
      S.reason = 'weak';
      S.note = '该点没有有效画面 · 已跳过';
      advanceCalib();
      return;
    }

    // 与上一个点相比眼球几乎没动 → 用户并没有真的看向靶点，跳过该点（不重来）
    const prev = S.samples[S.samples.length - 1];
    if (prev) {
      const d = Math.hypot(f.dLx - prev.f.dLx, f.dLy - prev.f.dLy);
      if (Number.isFinite(d) && d < MIN_GAZE_DELTA) {
        S.idx += 1;
        S.reason = 'noGaze';
        S.note = '该点没检测到视线移动 · 已跳过';
        advanceCalib();
        return;
      }
    }

    S.samples.push({ f, tx: p.tx, ty: p.ty, n, weak: n < minFrames });
    S.idx += 1;
    S.note = '';
    S.reason = '';
    advanceCalib();
  }

  /** 下一个点：先停 1 秒（靶点可见），再开始采样。 */
  function advanceCalib() {
    if (S.idx >= points.length) {
      fitNow();
      return;
    }
    S.gapUntil = S.lastNow + POINT_GAP_MS;
    S.phase = PHASE.CALIB;
  }

  function fitNow() {
    S.phase = PHASE.FIT;
    const model = fitPoly2(S.samples, { alpha: RIDGE_ALPHA });
    if (!model) {
      S.active = false;
      S.phase = PHASE.RESULT;
      S.report = {
        ok: false,
        status: 'fit-failed',
        reason: '拟合失败：样本不足或特征异常',
        samples: S.samples.length,
      };
      if (opts.onFail) opts.onFail(S.report);
      emit();
      return;
    }
    S.model = model;
    // 测试前同样给 3-2-1 准备时间
    S.next = PHASE.VALIDATE;
    S.phase = PHASE.READY;
    S.valIdx = 0;
    S.valErrors = [];
    S.valPointsResult = [];
    S.frames = [];
    S.acc = 0;
    S.ready = false;
    S.readyStreak = 0;
    S.pointStart = 0;
    S.valStart = 0;
    S.valDropped = 0;
    S.valDropReasons = {};
    S.valExtra = 0;
    S.note = '标定完成，准备开始测试';
    S.reason = '';
    emit();
  }

  /** 测试点：固定 1 秒窗口，用已采到的有效帧评分；不因不稳定重来。 */
  function finishValidatePoint() {
    const p = validatePoints[S.valIdx];
    let sum = 0;
    let n = 0;
    for (const f of S.frames) {
      const e = pointError(S.model, f, p);
      if (Number.isFinite(e)) {
        sum += e;
        n += 1;
      }
    }
    // 整整 1 秒一帧可用都没有：按满误差记 0 分（比跳过更能反映真实水平）
    const avg = n ? sum / n : SCORE_SPAN;
    S.valPointsResult.push({
      tx: p.tx,
      ty: p.ty,
      avg,
      score: scoreOf(avg),
      frames: n,
      dropped: S.valDropped,
      dropReasons: { ...S.valDropReasons },
      windowMs: sampleMs + S.valExtra,
    });
    if (Number.isFinite(avg)) S.valErrors.push(avg);
    S.frames = [];
    S.acc = 0;
    S.valDropped = 0;
    S.valDropReasons = {};
    S.valExtra = 0;
    S.valIdx += 1;
    S.valStart = 0;
    S.reason = '';

    if (S.valIdx >= validatePoints.length) {
      S.gapUntil = 0;
      finishValidate();
    } else {
      // 测试点之间同样停 1 秒：这一段由 overlay 在下一个点外圈闪两下提示
      S.gapUntil = S.lastNow + POINT_GAP_MS;
      S.note = '下一个点 · 1 秒后开始';
    }
  }

  function finishValidate() {
    const valid = S.valErrors.filter((x) => Number.isFinite(x));
    const avgDist = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN;
    const score = valid.length
      ? S.valPointsResult.reduce((a, b) => a + (Number.isFinite(b.score) ? b.score : 0), 0) /
        S.valPointsResult.length
      : 0;
    // 60 分通过（等价平均误差 0.16）；分数是主口径，avgDist 只用于展示
    const passed = Number.isFinite(score) && score >= PASS_SCORE;
    S.phase = PHASE.RESULT;
    S.active = false;
    S.report = {
      ok: passed,
      status: passed ? 'pass' : 'review',
      avgDist,
      score,
      passScore: PASS_SCORE,
      threshold: SCORE_SPAN * (1 - PASS_SCORE / 100),
      points: S.valPointsResult.slice(),
      samples: S.samples.slice(),
      model: S.model,
      fitAvg: S.model ? S.model.fit.avg : NaN,
      headRef: S.ref,
      startedAt: S.startedAt,
    };
    if (passed) {
      if (opts.onDone) opts.onDone(S.model, S.report);
    } else if (opts.onReview) {
      opts.onReview(S.report);
    }
    emit();
  }

  /** 验证未通过后：重新标定 */
  function recalibrate() {
    S.active = false;
    S.phase = PHASE.IDLE;
    start();
  }

  /** 验证未通过后：跳过（模型仍然会落库，由调用方执行） */
  function skip() {
    if (!S.report || !S.report.model) return null;
    S.report.skipped = true;
    return S.report.model;
  }

  function state() {
    return {
      phase: S.phase,
      next: S.next,
      idx: S.idx,
      total: points.length,
      valIdx: S.valIdx,
      valTotal: validatePoints.length,
      pointProgress: localProgress(),
      progress: totalProgress(),
      gap: gapLeft(),
      note: S.note,
      reason: S.reason,
      head: S.head,
      ready: !!S.ready,
      readyStreak: S.readyStreak,
      samples: S.samples.length,
      frames: S.frames.length,
      avgDist: S.report ? S.report.avgDist : null,
      score: S.report ? S.report.score : null,
      report: S.report,
    };
  }

  return {
    start,
    go,
    resume,
    pause,
    update,
    abort,
    recalibrate,
    skip,
    state,
    get phase() {
      return S.phase;
    },
    get report() {
      return S.report;
    },
    get model() {
      return S.model;
    },
  };
}

export default createSession;

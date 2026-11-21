/**
 * @file 标定模型与诊断文案。
 *
 * 从 `gaze-calib.js` 原样迁移；fit 里的 1-SE 规则、敏感度预算、退化门
 * 以及 2026-10-20 事故说明全部保留。
 */
import {
  CLICK_HALF_LIFE_MS,
  FEATURES,
  GRADE_LIMITS,
  HEAD_MOVE_WARN,
  LAMBDA_GRID,
  MAX_ACCEPT_ERR,
  MIN_EYE_STD,
  MIN_SAMPLES,
  MIN_STD,
  SENS_LIMIT,
  TERM_SETS,
  X_TERMS,
  Y_TERMS,
  avg,
  clamp01,
  median,
  sampleWeights,
  stddev,
} from './features.js';
import { dotStd, looScore } from './fit.js';

/* ---------------------------------------------------------------- 模型 */

export class GazeCalibModel {
  constructor(data = {}) {
    this.ok = !!data.ok;
    this.reason = data.reason || '';
    /** 用了哪套特征集：'full'（含头动项）或 'reduced' */
    this.variant = data.variant || 'full';
    this.termsX = Array.isArray(data.termsX) && data.termsX.length ? data.termsX : X_TERMS;
    this.termsY = Array.isArray(data.termsY) && data.termsY.length ? data.termsY : Y_TERMS;
    this.aspect = data.aspect || 4 / 3;
    this.created = data.created || 0;
    this.n = data.n || 0;
    this.mean = data.mean || null;
    this.std = data.std || null;
    this.wx = data.wx || null;
    this.wy = data.wy || null;
    this.quality = data.quality || null;
    /** 标定点的实测/预测对照，用于画误差图 */
    this.points = data.points || [];
    /** 诊断数据：眼球信号强度、头部移动、帧内抖动、相关性等（用于给用户可读建议） */
    this.diag = data.diag || null;
    // 标定时的头位基准：三页共享同一模型，也就共享同一基准
    this.headRef = data.headRef || null;
    /** 失败时可能同时命中多条（如「信号弱」+「头动大」） */
    this.reasons = data.reasons || null;
  }

  /**
   * 拟合。
   *
   * 质量分用**留一交叉验证**（每次拿 8 个点拟合、预测剩下的那点）而不是样本内残差：
   * 6 个参数只有 9 个点，样本内残差必然偏乐观（实测样本内 ~1.5% 而留一 ~3~5%）。
   * 用户看到的是留一误差，也就是「换个新位置大概差多少」。
   *
    * @param {Array<{f:object, tx:number, ty:number}>} samples 每个标定点一条（已取中位数）
    *        在线学习的点击样本额外带 {kind:'click', t}；标定样本不带 kind（等价于 kind:'calib'）
    * @param {object} [opts]
    * @param {number} [opts.now] 当前时间戳（ms），用于点击样本的时间衰减
    * @param {number} [opts.halfLifeMs] 点击样本权重半衰期
    */
  static fit(samples, { aspect = 4 / 3, ridge = 0.01, created = 0, now = 0, halfLifeMs = CLICK_HALF_LIFE_MS } = {}) {
    const pts = (samples || []).filter(
      (s) => s && s.f && isFinite(s.tx) && isFinite(s.ty) && FEATURES.every((k) => isFinite(s.f[k])),
    );
    if (pts.length < MIN_SAMPLES) {
      return new GazeCalibModel({ ok: false, reason: 'insufficient', n: pts.length, aspect, created });
    }
    // 点击样本按年龄衰减加权；没有点击样本时返回 null ⇒ 后续全程走无权重的旧路径
    const weights = sampleWeights(pts, now, halfLifeMs);

    // 两套特征集：各自在 λ 网格上挑配置，再按 1-SE 规则二选一（见下）。
    // 挑 λ 时不是「留一误差最小就赢」：留一误差只覆盖「同一坐姿内的新注视点」，
    // 完全看不到「演示时微动一下会不会跳」这一维。2026-10-20 真机数据里，纯按留一最优选出的
    // λ 会让「脸前后动 0.1%」把光标推走 12.5% 屏高——所以先筛掉超敏感度预算的配置，
    // 在达标者里再按留一比精度；一个都不达标时退而求其次，取最不敏感的那个。
    const grid = Array.from(new Set([...(isFinite(ridge) ? [ridge] : []), ...LAMBDA_GRID])).sort((a, b) => a - b);
    const cands = [];
    for (const name of Object.keys(TERM_SETS)) {
      const set = TERM_SETS[name];
      const tried = [];
      for (const lam of grid) {
        const r = looScore(pts, lam, aspect, set, weights);
        if (r) tried.push({ ...r, lam, sensWorst: Math.max(r.sens.head, r.sens.dist, r.sens.tilt) });
      }
      if (!tried.length) continue;
      const safe = tried.filter((t) => t.sensWorst <= SENS_LIMIT);
      const pool = safe.length ? safe : tried;
      // 达标者比留一误差；无人达标时比敏感度（同分再比留一）
      pool.sort((a, b) => (safe.length ? a.avgErr - b.avgErr : a.sensWorst - b.sensWorst || a.avgErr - b.avgErr));
      const scored = pool[0];
      cands.push({
        name,
        ...scored,
        quality: {
          avgErr: scored.avgErr,
          maxErr: scored.maxErr,
          fitErr: scored.fitErr,
          cv: scored.cv,
          grade: scored.avgErr <= GRADE_LIMITS.good ? 'good' : scored.avgErr <= GRADE_LIMITS.ok ? 'ok' : 'poor',
        },
      });
    }
    if (!cands.length) {
      return new GazeCalibModel({ ok: false, reason: 'singular', n: pts.length, aspect, created });
    }

    // 选特征集：先取留一平均误差最小的那套（best），再做 1-SE 规则——
    // 若另一套的误差落在「best ± 一个标准误」内，就取**参数更少**的那套。
    // 理由：full 多了 faceCx/faceCy 两个头动项。标定时头几乎不动的话（真机见 rawStd.faceCx=0.0014），
    // 这两项是在噪声里拟合出来的，用它只换来微不足道的精度，却让"演示时头一动光标就跳"（实测系数
    // 可达 0.13 归一化单位/1% 头动）。统计上也标准（Breiman 的 one-standard-error rule）。
    cands.sort((a, b) => a.avgErr - b.avgErr);
    const best = cands[0];
    const errs = best.looErr.filter((v) => isFinite(v));
    const se = errs.length > 1 ? stddev(errs, avg(errs)) / Math.sqrt(errs.length) : 0;
    const limit = best.avgErr + se;
    const eligible = cands.filter((c) => c.avgErr <= limit);
    eligible.sort((a, b) => (a.terms - b.terms) || (a.avgErr - b.avgErr));
    const pick = eligible[0] || best;

    const model = new GazeCalibModel({
      ok: true,
      reason: '',
      aspect,
      created,
      n: pts.length,
      variant: pick.name,
      termsX: TERM_SETS[pick.name].x,
      termsY: TERM_SETS[pick.name].y,
      mean: pick.core.mean,
      std: pick.core.std,
      wx: pick.core.wx,
      wy: pick.core.wy,
      points: pick.points,
      quality: pick.quality,
    });

    // ---- 诊断：把「为什么准 / 为什么不准」变成可读信息（采集端的帧级统计会合并进来）----
    const st = pts.map((p) => p.stats).filter(Boolean);
    const diag = { ...best.core.stats };
    diag.variant = pick.name;
    diag.scores = {};
    diag.lambdas = {};
    for (const c of cands) {
      diag.scores[c.name] = c.avgErr;
      diag.lambdas[c.name] = c.lam;
    }
    diag.lambda = pick.lam;
    diag.se = se;
    // 是否因为「1-SE 规则」选了参数更少的那套（诊断要据此换一种说法）
    diag.pickedBySE = pick !== best;
    // 在线学习（点击即训练）的状态：weighted=false 表示这次拟合没有任何点击样本，
    // 结果与「纯 9 点标定」逐位一致（排查精度回退时可以先看这个开关）
    diag.weighted = !!weights;
    diag.nClick = pts.filter((p) => p.kind === 'click').length;
    diag.looErr = pick.looErr.map((v) => (isFinite(v) ? Math.round(v * 1e4) / 1e4 : null));
    diag.frames = st.length ? Math.round(avg(st.map((s) => s.n || 0))) : null;
    diag.jitter = st.length ? median(st.map((s) => s.jitter || 0)) : null;
    diag.headRange = st.length ? median(st.map((s) => s.headRange || 0)) : null;
    diag.openness = st.length ? median(st.map((s) => s.openness || 0)) : null;
    diag.dropped = st.reduce((a, s) => a + (s.dropped || 0), 0);
    diag.worstAt = pick.worstAt;
    // 演示鲁棒性：小动作引起的光标位移（留一误差看不到这一维）
    const sens = pick.sens;
    diag.sens = { ...sens, limit: SENS_LIMIT };
    diag.sensWorst = Math.max(sens.head, sens.dist, sens.tilt);
    diag.sensOk = diag.sensWorst <= SENS_LIMIT;
    model.diag = diag;

    // ---- 退化门：不合格就明确失败，绝不把废模型交给光标 ----
    // 依据是 2026-10-20 实测事故：真人标定留一误差 50.4%，但旧代码因为 MIN_STD 只夹分母
    // 依然标 ok，预测点撒满全屏。宁可让用户「重做」，也不要给出乱飞的光标。
    const reasons = [];
    if (diag.eyeStdX < MIN_EYE_STD.x || diag.eyeStdY < MIN_EYE_STD.y) reasons.push('weak-eye-signal');
    if (best.avgErr > MAX_ACCEPT_ERR) reasons.push('poor-fit');
    if (reasons.length) {
      model.ok = false;
      model.reason = reasons[0];
      model.reasons = reasons;
    }
    return model;
  }

  /** @returns {{x:number,y:number,conf:number}|null} 屏幕归一化坐标 */
  predict(f) {
    if (!this.ok || !f || !this.mean || !this.std) return null;
    for (const k of FEATURES) if (!isFinite(f[k])) return null;
    const x = clamp01(dotStd(this.wx, this.termsX, f, this.mean, this.std));
    const y = clamp01(dotStd(this.wy, this.termsY, f, this.mean, this.std));
    const avgErr = (this.quality && this.quality.avgErr) || 0.08;
    const conf = clamp01(1 - avgErr / 0.15);
    return { x, y, conf: Math.max(0.15, conf) };
  }

  toJSON() {
    return {
      // v3：特征集变成可选的（full/reduced），权重长度随 terms 变化；v2 及更早一律拒绝加载
      v: 3,
      ok: this.ok,
      reason: this.reason,
      variant: this.variant,
      termsX: this.termsX,
      termsY: this.termsY,
      aspect: this.aspect,
      created: this.created,
      n: this.n,
      mean: this.mean,
      std: this.std,
      wx: this.wx,
      wy: this.wy,
      quality: this.quality,
      points: this.points,
      diag: this.diag,
      headRef: this.headRef,
    };
  }

  static fromJSON(obj) {
    if (!obj || typeof obj !== 'object' || obj.v !== 3 || !obj.ok) return null;
    const m = new GazeCalibModel(obj);
    // 严格校验：缺一项就没法预测，宁可当「未标定」也不要带着坏模型跑
    if (!m.mean || !m.std || !Array.isArray(m.wx) || !Array.isArray(m.wy)) return null;
    if (m.wx.length !== m.termsX.length + 1 || m.wy.length !== m.termsY.length + 1) return null;
    for (const k of m.termsX.concat(m.termsY)) if (FEATURES.indexOf(k) < 0) return null;
    for (const w of [m.wx, m.wy]) {
      for (const v of w) if (!isFinite(v)) return null;
    }
    for (const k of FEATURES) {
      if (!isFinite(m.mean[k]) || !isFinite(m.std[k]) || !(m.std[k] > 0)) return null;
    }
    // 质量门槛：即使存的是 ok:true，误差超过可用上限也不加载
    // （旧代码曾把 50.4% 的废模型标成 ok 存下来，这一条专门挡住这类脏数据）
    if (m.quality && isFinite(m.quality.avgErr) && m.quality.avgErr > MAX_ACCEPT_ERR) return null;
    if (!isFinite(m.aspect) || m.aspect <= 0.1) m.aspect = 4 / 3;
    return m;
  }
}

/**
 * 把诊断数据翻译成「用户能照着做」的中文提示（结果页直接逐行显示）。
 * 设计原则：先说结论（能不能用），再说原因，最后给一句可执行建议。
 * @param {GazeCalibModel|null} model
 * @returns {string[]}
 */
/** 把归一化坐标翻成九宫格方位词（用于"最差的是哪一块"这类诊断） */
function zoneName(pt) {
  const x = pt[0];
  const y = pt[1];
  const hz = x < 0.34 ? '左' : x > 0.66 ? '右' : '';
  const vz = y < 0.34 ? '上' : y > 0.66 ? '下' : '';
  if (vz && hz) return `屏幕${hz}${vz}角`;
  if (vz) return `屏幕${vz}边中间`;
  if (hz) return `屏幕${hz}边中间`;
  return '屏幕正中';
}

export function diagnoseText(model) {
  const pc = (v) => `${(Number(v) * 100).toFixed(1)}%`;
  if (!model) return ['还没做标定：点「重新标定」跟完 9 个点即可。'];
  const d = model.diag || {};
  const q = model.quality || {};

  if (model.reason === 'insufficient') {
    return [
      `有效标定点只有 ${model.n} 个（至少需要 ${MIN_SAMPLES} 个）：采集期间多半没检测到人脸（光线不足、脸太小、频繁眨眼）。`,
      '建议：正对摄像头、把脸靠近到画面 1/3 以上，再重做一次。',
    ];
  }
  if (model.reason === 'singular') return ['标定数据病态（特征共线或某个点完全重复），无法求解，请重做。'];

  const out = [];
  const s = d.scores || {};
  if (isFinite(s.full) && isFinite(s.reduced)) {
    // "明显"的统一尺度 = 留一误差的 1 个标准误（与 1-SE 择优规则一致），不再用拍出来的倍数
    const se = isFinite(d.se) ? d.se : 0;
    if (d.pickedBySE) {
      // 1-SE 规则选中的：两套差别不显著 → 取参数更少的纯眼球模型（更抗头动）
      out.push(
        `两套模型的精度差别在噪声范围内（含头动项 ${pc(s.full)}、纯眼球 ${pc(s.reduced)}）：按「差别不显著就选更简单的」规则，已采用纯眼球模型——你演示时头怎么动，光标都不会突然跳（代价是头动补偿弱一点）。`,
      );
    } else if (d.variant === 'reduced') {
      out.push(
        `含头动项的模型明显更差（${pc(s.full)} vs ${pc(s.reduced)}）：标定期间头部移动污染了数据，已自动改用纯眼球模型。下次标定时让下巴别动。`,
      );
    } else if (s.reduced - s.full > se) {
      out.push(
        `含头动项的模型明显更好（${pc(s.full)} vs ${pc(s.reduced)}）：你标定时头有配合移动，已保留头动补偿（换坐姿后更稳）。`,
      );
    } else {
      out.push(
        `两套模型精度几乎一样（含头动项 ${pc(s.full)}、纯眼球 ${pc(s.reduced)}）：保留了头动补偿，你配合移动时会更稳。`,
      );
    }
  }
  const weakEye = d.eyeStdX != null && (d.eyeStdX < MIN_EYE_STD.x || d.eyeStdY < MIN_EYE_STD.y);
  if (weakEye) {
    out.push(
      `眼球位移信号太弱（横向 ${pc(d.eyeStdX)}、纵向 ${pc(d.eyeStdY)} 眼宽）：标定时眼睛几乎没有跟着点动，或者脸离摄像头太远/光线不足，虹膜关键点本身就不准。`,
    );
    out.push('建议：只动眼睛别动头；脸靠近摄像头到画面 1/3 以上；正面朝向光源（别背光、别让灯在身后）；然后重做。');
  }
  if (model.reasons && model.reasons.indexOf('poor-fit') >= 0) {
    out.push(
      `模型跟不上你的注视（平均留一误差 ${pc(q.avgErr || 0)}，超过可用上限 ${pc(MAX_ACCEPT_ERR)}）：这组数据里「眼球位置」和「你看哪里」没有稳定关系。`,
    );
    out.push('常见原因：跟点时用转头代替转眼、眼睛没等红点就位、或这台摄像头的虹膜关键点不可靠。建议严格「只动眼睛」重做一次。');
  }
  if (d.headMove != null && d.headMove > HEAD_MOVE_WARN) {
    out.push(
      `标定期间头部移动偏大（${pc(d.headMove)} 画面宽）：头一动，同一条视线对应的虹膜位置就变了，模型会去拟合头动。下次下巴别动、只转眼球。`,
    );
  }
  if (d.jitter != null && d.jitter > 0.02) {
    out.push(`帧内抖动偏大（${pc(d.jitter)} 眼宽）：补光 + 靠近摄像头能明显改善。`);
  }
  if (d.corrX != null && d.corrX < 0.5) {
    out.push(`虹膜横向位移与注视目标的相关系数只有 ${Number(d.corrX).toFixed(2)}（正常应 > 0.8），横向注视几乎没有反映到虹膜位移上。`);
  }
  if (d.dropped) out.push(`已自动剔除 ${d.dropped} 个离群帧（眨眼/跳变），不影响上面的结论。`);

  if (model.ok) {
    const g = q.grade === 'good' ? '优' : q.grade === 'ok' ? '良' : '偏低';
    const avg = q.avgErr || 0;
    // 建议按评级分档：不能只因为"能过质量门"就承诺四角也准（首次真人实测就是这么翻车的）
    const mx = q.maxErr || 0;
    const advice =
      avg <= GRADE_LIMITS.good
        ? mx <= GRADE_LIMITS.good
          ? '中心区和四角按钮基本都能命中。'
          : `中心区很稳，个别方位仍会偏（最差 ${pc(mx)}）：那一片的按钮放大一点，或挪到中间。`
        : avg <= GRADE_LIMITS.ok
          ? '中心区按钮可以正常注视点击；越靠近四角越容易偏，重要按钮尽量放中间。'
          : '误差偏大，建议配合放大目标使用，或重做一次。';
    out.push(`本次标定可用：留一误差 平均 ${pc(avg)} / 最大 ${pc(q.maxErr || 0)}，评级 ${g}。${advice}`);
    // 最大误差落在哪个方位（现场据此决定按钮摆哪）
    if (d.worstAt && (avg > GRADE_LIMITS.good || mx > GRADE_LIMITS.good)) {
      out.push(`误差最大的是${zoneName(d.worstAt)}那个点（约 ${pc(q.maxErr || 0)} 屏宽）：这块区域的小按钮先别指望，重要操作放中心。`);
    }
  } else if (!out.length) {
    out.push('本次标定不可用，请重做。');
  }
  return out;
}

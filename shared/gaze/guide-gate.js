/**
 * @file 就位判定（纯逻辑，无 DOM）。
 *
 * 工作台「把脸放进框里」的四项检查就靠这里：
 *   - 距离：人脸高度 / 推荐框高度 的比值
 *   - 居中：人脸框中心相对画面中心的偏移
 *   - 姿态：roll 歪头 / yaw 侧脸 / pitchRatio 俯仰
 *
 * 之所以不用 `headPose().poseOk`：
 *   - 距离用的是绝对 faceH 区间（0.22~0.8），远端 0.25 也算「合适」，
 *     于是人退后两米框还是绿的；
 *   - pitch 用的是鼻尖相对眼中心的角度，这两个点几乎在同一刚体上，
 *     2D 投影里抬头低头只有 1~2° 变化，实测永远显示「平视」。
 *
 * 阈值集中在 LIMITS 里，工作台与测试共用。
 */

export const LIMITS = Object.freeze({
  /** 推荐框高度（占画面高度）。人脸高度贴到它附近才算距离合适。 */
  targetH: 0.5,
  /** 距离容差：比值在 1±tolerance 内为 ok，1±hard 内为 warn，其余 bad。 */
  distOk: 0.16,
  distWarn: 0.32,
  /** 居中容差（归一化到画面宽/高）。 */
  centerOkX: 0.055,
  centerOkY: 0.06,
  centerWarnX: 0.11,
  centerWarnY: 0.12,
  /** 姿态。 */
  rollOk: 10,
  rollWarn: 18,
  yawOk: 16,
  yawWarn: 25,
  /** 俯仰：pitchRatio 相对中性值的偏移。 */
  pitchWarn: 0.034,
  pitchBad: 0.062,
  /** 学习中性俯仰时的允许漂移。 */
  neutralDrift: 0.07,
});

const LEVEL = { ok: 0, warn: 1, bad: 2 };

function raise(level, next) {
  return LEVEL[next] > LEVEL[level] ? next : level;
}

/**
 * @param {object} h headPose() 的返回值
 * @param {{targetH?:number, neutral?:number|null, limits?:object}} [ctx]
 * @returns {{
 *   ratio:number,
 *   dist:'ok'|'warn'|'bad', distText:string,
 *   cen:'ok'|'warn'|'bad', cenText:string,
 *   pose:'ok'|'warn'|'bad', poseText:string,
 *   level:'ok'|'warn'|'bad'
 * }}
 */
export function judgeGuide(h, ctx = {}) {
  const L = ctx.limits || LIMITS;
  const targetH = ctx.targetH || L.targetH;
  const ratio = h.faceH / targetH;

  let dist = 'ok';
  let distText = '合适';
  if (ratio < 1 - L.distOk) {
    dist = ratio < 1 - L.distWarn ? 'bad' : 'warn';
    distText = dist === 'bad' ? '太远' : '略远';
  } else if (ratio > 1 + L.distOk) {
    dist = ratio > 1 + L.distWarn ? 'bad' : 'warn';
    distText = dist === 'bad' ? '太近' : '略近';
  }

  const cx0 = (ctx.center && ctx.center.x) || 0.5;
  const cy0 = (ctx.center && ctx.center.y) || 0.5;
  const dx = h.cx - cx0;
  const dy = h.cy - cy0;
  let cen = 'ok';
  let cenText = '居中';
  if (Math.abs(dx) > L.centerOkX || Math.abs(dy) > L.centerOkY) {
    const far = Math.abs(dx) > L.centerWarnX || Math.abs(dy) > L.centerWarnY;
    cen = far ? 'bad' : 'warn';
    cenText =
      Math.abs(dx) >= Math.abs(dy)
        ? dx > 0
          ? '偏右'
          : '偏左'
        : dy > 0
          ? '偏下'
          : '偏上';
  }

  let pose = 'ok';
  let poseText = '平视';
  const roll = Number.isFinite(h.roll) ? Math.abs(h.roll) : 0;
  const yaw = Number.isFinite(h.yaw) ? Math.abs(h.yaw) : 0;
  if (roll > L.rollOk) {
    pose = roll > L.rollWarn ? 'bad' : 'warn';
    poseText = '歪头';
  } else if (yaw > L.yawOk) {
    pose = yaw > L.yawWarn ? 'bad' : 'warn';
    poseText = '侧脸';
  } else if (Number.isFinite(h.pitchRatio) && Number.isFinite(ctx.neutral)) {
    const d = h.pitchRatio - ctx.neutral;
    if (Math.abs(d) > L.pitchBad) {
      pose = 'bad';
      // 仰头时下巴向相机靠近，投影里「鼻→下巴」被拉长，比值反而变小
      poseText = d > 0 ? '低头了' : '仰头了';
    } else if (Math.abs(d) > L.pitchWarn) {
      pose = 'warn';
      poseText = d > 0 ? '略低头' : '略仰头';
    }
  }

  let level = 'ok';
  level = raise(level, dist);
  level = raise(level, cen);
  level = raise(level, pose);

  return { ratio, dist, distText, cen, cenText, pose, poseText, level };
}

/**
 * 是否可以用当前帧学习「中性俯仰」。
 * @param {object} h headPose() 的返回值
 * @param {number} elapsed 进入引导后经过的毫秒
 * @param {object} [limits]
 */
export function canLearnNeutral(h, elapsed, limits = LIMITS, center) {
  if (!Number.isFinite(h.pitchRatio)) return false;
  if (elapsed < 1500) return false;
  const ratio = h.faceH / limits.targetH;
  const cx0 = (center && center.x) || 0.5;
  const cy0 = (center && center.y) || 0.5;
  return (
    ratio > 1 - limits.distOk &&
    ratio < 1 + limits.distOk &&
    Math.abs(h.cx - cx0) <= limits.centerOkX &&
    Math.abs(h.cy - cy0) <= limits.centerOkY &&
    Math.abs(h.roll) <= limits.rollOk &&
    Math.abs(h.yaw) <= limits.yawOk
  );
}

/**
 * 在线更新中性俯仰（带漂移上限，避免情绪/疲劳导致的缓慢偏移被当成平视）。
 * @param {number|null} neutral 当前中性值
 * @param {number} ratio 本帧 pitchRatio
 * @param {object} [limits]
 * @returns {number|null}
 */
export function stepNeutral(neutral, ratio, limits = LIMITS) {
  if (!Number.isFinite(ratio)) return neutral;
  if (neutral == null) return ratio;
  if (Math.abs(ratio - neutral) > limits.neutralDrift) return neutral;
  return neutral + (ratio - neutral) * 0.02;
}

/**
 * @file 标定途中的「预览映射」。
 *
 * 正式模型 `GazeCalibModel.fit` 要求至少 8 个有效标定点（`MIN_SAMPLES`），
 * 也就是说 9 点流程里前 8 个点都拿不到预测——用户只能看到一个和注视位置无关的粗光标，
 * 观感就是「视线根本没跟过去」。
 *
 * 这里给一个一元线性映射：
 *   x = a0 + a1 * dLx
 *   y = b0 + b1 * dLy
 * 两个点就能解，加点就更新。它只负责让光标**朝用户看的方向动**，
 * 精度不重要，最终模型仍然走正式 `fit`。
 *
 * 为什么不用多元回归：点少时特征彼此近似共线，3×3 正规方程会病态，
 * 解出来的斜率被岭正则压小，光标反而不动。水平和垂直各解一条直线，
 * 数学上更稳，也符合「向左看→虹膜往左」的主对角关系。
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 一元最小二乘。特征方差过小（所有样本几乎同一位置）时退化为常数。
 * @returns {[number, number]} [截距, 斜率]
 */
function linreg(rows, key, target, lam) {
  const n = rows.length;
  let sx = 0;
  let sy = 0;
  for (const s of rows) {
    sx += s.f[key];
    sy += s[target];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of rows) {
    const dx = s.f[key] - mx;
    sxx += dx * dx;
    sxy += dx * (s[target] - my);
  }
  // 方差太小就别拟合斜率了，否则一点点噪声会放大成巨大斜率
  if (sxx < 1e-6) return [my, 0];
  return [my - (sxy / (sxx + lam)) * mx, sxy / (sxx + lam)];
}

/**
 * @param {Array<{f:{dLx:number,dLy:number}, tx:number, ty:number}>} samples
 * @param {{lambda?:number, minPoints?:number}} [opts]
 * @returns {{predict:(f:object)=>{x:number,y:number}, n:number}|null}
 */
export function fitPreview(samples, opts = {}) {
  const lam = Number.isFinite(opts.lambda) ? opts.lambda : 1e-5;
  const minPoints = Number.isFinite(opts.minPoints) ? opts.minPoints : 2;
  const rows = (samples || []).filter(
    (s) =>
      s && s.f &&
      Number.isFinite(s.f.dLx) && Number.isFinite(s.f.dLy) &&
      Number.isFinite(s.tx) && Number.isFinite(s.ty),
  );
  if (rows.length < minPoints) return null;

  const wx = linreg(rows, 'dLx', 'tx', lam);
  const wy = linreg(rows, 'dLy', 'ty', lam);

  return {
    n: rows.length,
    predict(f) {
      if (!f || !Number.isFinite(f.dLx) || !Number.isFinite(f.dLy)) return null;
      return {
        x: clamp01(wx[0] + wx[1] * f.dLx),
        y: clamp01(wy[0] + wy[1] * f.dLy),
      };
    },
  };
}

export default fitPreview;

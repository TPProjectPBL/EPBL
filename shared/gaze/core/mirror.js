/**
 * @file 关键点镜像（统一标定协议的唯一镜像实现）。
 *
 * 协议：MediaPipe 输出后对所有关键点 x 执行 `x = 1 - x`。
 * 特征提取、头姿计算、预测必须走同一份镜像坐标，否则训练与推理不在同一空间。
 */

/**
 * 返回镜像后的关键点副本（不改原数组）。
 * @param {Array<{x:number,y:number,z?:number}>} lm
 * @returns {Array<{x:number,y:number,z?:number}>|null}
 */
export function mirrorLandmarks(lm) {
  if (!Array.isArray(lm)) return null;
  const out = new Array(lm.length);
  for (let i = 0; i < lm.length; i += 1) {
    const p = lm[i];
    out[i] = p ? { x: 1 - p.x, y: p.y, z: p.z } : p;
  }
  return out;
}

export default mirrorLandmarks;

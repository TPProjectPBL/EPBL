/**
 * 关键点索引一致性检查（纯浏览器模块，可被页面直接 import）。
 *
 * 比较 Tasks FaceLandmarker（新）与 legacy FaceMesh（旧）在
 * 468/473（虹膜）、33/133/263/362（眼角）上的归一化坐标。
 *
 * 用法：
 *   const { runCheckInPage } = await import('/shared/gaze/engine/check-in-page.js');
 *   await runCheckInPage({ imageUrl: '/path/to/face.jpg' });
 */

export const IDX = Object.freeze({
  leftIris: 468,
  rightIris: 473,
  leftEyeOuter: 33,
  leftEyeInner: 133,
  rightEyeOuter: 263,
  rightEyeInner: 362,
});

export const LABEL = {
  468: '左虹膜',
  473: '右虹膜',
  33: '左眼外角',
  133: '左眼内角',
  263: '右眼外角',
  362: '右眼内角',
};

const DEFAULT_ENGINE_PATH = new URL('./face-engine.js', import.meta.url).href;

/**
 * @param {{ imageUrl?: string, enginePath?: string }} [options]
 * @returns {Promise<{tasks:object, legacy:object, delta:object, imageUrl:boolean}>}
 */
export async function runCheckInPage(options = {}) {
  const { imageUrl = null, enginePath = DEFAULT_ENGINE_PATH } = options;

  const loadImage = (src) =>
    new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });

  let image = null;
  if (imageUrl) image = await loadImage(imageUrl);
  if (!image) {
    // 无图时合成一张灰底图：能跑通链路，但不会检测到真实人脸
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 480;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, c.width, c.height);
    image = c;
  }

  const mod = await import(enginePath);
  const tasks = { ok: false };
  let engine = null;
  try {
    engine = await mod.createFaceEngine({});
    const r = await engine.push(image, 1);
    if (r && r.landmarks) {
      tasks.ok = true;
      tasks.count = r.landmarks.length;
      tasks.delegate = engine.delegate;
      tasks.modelSource = engine.modelSource;
      tasks.points = {};
      for (const k of Object.keys(IDX)) {
        const p = r.landmarks[IDX[k]];
        tasks.points[k] = p ? { x: +p.x.toFixed(5), y: +p.y.toFixed(5), z: +(p.z || 0).toFixed(5) } : null;
      }
    } else {
      tasks.reason = (r && r.reason) || 'no-result';
      tasks.count = (r && r.count) || 0;
    }
  } catch (err) {
    tasks.error = String((err && err.message) || err);
  } finally {
    if (engine) engine.close();
  }

  const legacy = { ok: false, available: !!window.FaceMesh };
  if (window.FaceMesh && image && image.width) {
    try {
      // 旧 FaceMesh 对超大图容易首帧失败，先缩到 640 宽，并连发几次预热
      const cv = document.createElement('canvas');
      const scale = Math.min(1, 640 / image.width);
      cv.width = Math.max(1, Math.round(image.width * scale));
      cv.height = Math.max(1, Math.round(image.height * scale));
      cv.getContext('2d').drawImage(image, 0, 0, cv.width, cv.height);

      const mesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
      mesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });

      let got = null;
      mesh.onResults((res) => {
        const lm = res && res.multiFaceLandmarks && res.multiFaceLandmarks[0];
        if (lm && lm.length >= 478) got = lm;
      });

      for (let attempt = 0; attempt < 3 && !got; attempt += 1) {
        await mesh.send({ image: cv });
        if (!got) await new Promise((r) => setTimeout(r, 150));
      }

      if (got) {
        legacy.ok = true;
        legacy.count = got.length;
        legacy.points = {};
        for (const k of Object.keys(IDX)) {
          const p = got[IDX[k]];
          legacy.points[k] = p ? { x: +p.x.toFixed(5), y: +p.y.toFixed(5), z: +(p.z || 0).toFixed(5) } : null;
        }
      } else {
        legacy.reason = 'no-face';
      }
      try {
        mesh.close();
      } catch (e) {}
    } catch (err) {
      legacy.error = String((err && err.message) || err);
    }
  }

  const delta = {};
  if (tasks.ok && legacy.ok) {
    for (const k of Object.keys(IDX)) {
      const a = tasks.points[k];
      const b = legacy.points[k];
      delta[k] = a && b ? +Math.hypot(a.x - b.x, a.y - b.y).toFixed(5) : null;
    }
  }

  return { tasks, legacy, delta, imageUrl: !!imageUrl };
}

/**
 * 渲染模块（阶段 1）：把检测结果绘制到画布，返回检测摘要。
 * 保持纯函数、无全局依赖，便于后续单元测试。
 */

function drawConnectors(ctx, landmarks, connections, color, width, w, h) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i < connections.length; i++) {
    const a = connections[i][0];
    const b = connections[i][1];
    const p1 = landmarks[a];
    const p2 = landmarks[b];
    if (!p1 || !p2) continue;
    ctx.moveTo(p1.x * w, p1.y * h);
    ctx.lineTo(p2.x * w, p2.y * h);
  }
  ctx.stroke();
}

function drawLandmarks(ctx, landmarks, color, size, w, h) {
  ctx.fillStyle = color;
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * @param {object} args
 *   ctx, canvas, video, faceResults, handResults,
 *   faceTesselation, faceIrises, handConnections
 * @returns {{hasFace:boolean, hasIris:boolean, hasHand:boolean}}
 */
export function drawFrame(args) {
  const {
    ctx, canvas, video,
    faceResults, handResults,
    faceTesselation, faceIrises, handConnections,
  } = args;

  if (video && video.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  let hasFace = false;
  let hasIris = false;
  const faces = faceResults && faceResults.multiFaceLandmarks;
  if (faces) {
    for (const lm of faces) {
      hasFace = true;
      if (faceTesselation && faceTesselation.length) {
        drawConnectors(ctx, lm, faceTesselation, 'rgba(80,170,255,0.55)', 1, w, h);
      }
      if (lm.length >= 478) {
        hasIris = true;
        if (faceIrises && faceIrises.length) {
          drawConnectors(ctx, lm, faceIrises, 'rgba(255,80,120,0.95)', 2, w, h);
        }
        drawLandmarks(ctx, lm.slice(468), '#ff5078', 2.5, w, h);
      }
    }
  }

  let hasHand = false;
  const hands = handResults && handResults.multiHandLandmarks;
  if (hands) {
    for (const lm of hands) {
      hasHand = true;
      if (handConnections && handConnections.length) {
        drawConnectors(ctx, lm, handConnections, 'rgba(80,220,150,0.9)', 2, w, h);
      }
      drawLandmarks(ctx, lm, '#50dc96', 3, w, h);
    }
  }

  return { hasFace, hasIris, hasHand };
}

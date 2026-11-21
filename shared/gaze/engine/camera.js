/**
 * @file 统一摄像头入口。
 *
 * 只做一件事：拿到一个**可复用的 MediaStream + video 元素**。
 * 同一次打开返回的 `video` 可以同时喂给 FaceLandmarker 与 HandLandmarker，
 * 不需要为了第二个模型再申请一遍摄像头（也避免两个 stream 抢设备）。
 *
 * 不在这里做推理、不做镜像、不画预览。
 */

const ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: 'permission-denied',
  DEVICE_NOT_FOUND: 'device-not-found',
  DEVICE_BUSY: 'device-busy',
  INSECURE_CONTEXT: 'insecure-context',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
});

function fail(code, err) {
  return {
    ok: false,
    error: {
      code,
      name: (err && err.name) || '',
      message: (err && err.message) || String(err || code),
    },
  };
}

function mapError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return ERROR_CODES.PERMISSION_DENIED;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return ERROR_CODES.DEVICE_NOT_FOUND;
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return ERROR_CODES.DEVICE_BUSY;
    default:
      return ERROR_CODES.UNKNOWN;
  }
}

/**
 * 打开摄像头。
 *
 * @param {object} [options]
 * @param {number} [options.width=640]
 * @param {number} [options.height=480]
 * @param {'user'|'environment'} [options.facingMode='user']
 * @param {string} [options.deviceId] 指定设备时优先于 facingMode
 * @returns {Promise<
 *   {ok:true, video:HTMLVideoElement, stream:MediaStream, stop:()=>void, width:number, height:number} |
 *   {ok:false, error:{code:string, name:string, message:string}}
 * >}
 */
export async function openCamera(options = {}) {
  const { width = 640, height = 480, facingMode = 'user', deviceId } = options;

  if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return fail(ERROR_CODES.UNSUPPORTED, new Error('navigator.mediaDevices.getUserMedia 不可用'));
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return fail(ERROR_CODES.INSECURE_CONTEXT, new Error('需要 HTTPS 或 localhost'));
  }

  const videoConstraints = {
    width: { ideal: width },
    height: { ideal: height },
  };
  if (deviceId) videoConstraints.deviceId = { exact: deviceId };
  else videoConstraints.facingMode = { ideal: facingMode };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
  } catch (err) {
    return fail(mapError(err), err);
  }

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;

  try {
    await video.play();
  } catch (err) {
    // 自动播放被拦截不算致命：调用方可以稍后手动 play()，或直接等 loadedmetadata。
    console.warn('[camera] video.play() 被拦截，继续等待元数据', err);
  }

  if (video.readyState < 1) {
    await new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', done);
        resolve();
      };
      timer = setTimeout(done, 5000); // 设备异常时不让调用方永久挂起
      video.addEventListener('loadedmetadata', done);
    });
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch (err) {
        console.warn('[camera] track.stop 异常', err);
      }
    }
    if (video.srcObject === stream) video.srcObject = null;
    try {
      video.pause();
    } catch (err) {
      /* 忽略 */
    }
  };

  return {
    ok: true,
    video,
    stream,
    stop,
    get width() {
      return video.videoWidth || width;
    },
    get height() {
      return video.videoHeight || height;
    },
  };
}

export { ERROR_CODES as CAMERA_ERROR_CODES };

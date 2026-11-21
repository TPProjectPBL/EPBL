/**
 * @file 共享眼动核心的统一出口。
 *
 * 导出清单与原 `air-runner/lib/gaze-calib.js` 保持一致，
 * 调用方只改 import 路径，不改符号名。
 */
export {
  FEATURES,
  TERM_SETS,
  X_TERMS,
  Y_TERMS,
  LAMBDA_GRID,
  MIN_SAMPLES,
  GRADE_LIMITS,
  MIN_EYE_STD,
  HEAD_MOVE_WARN,
  MAX_ACCEPT_ERR,
  CLICK_WEIGHT,
  CLICK_HALF_LIFE_MS,
  CLICK_WEIGHT_FLOOR,
  POSE_TERMS,
  POSE_SHRINK,
  SENS_LIMIT,
  SENS_PROBE,
  sampleWeights,
  extractFeatures,
  extractFeaturesMirrored,
  eyeOpenness,
  isFaceUsable,
  median,
  medianLandmarks,
  medianSample,
  simLandmarksFor,
} from './features.js';
export { sensitivityOf } from './fit.js';
export { GazeCalibModel, diagnoseText } from './model.js';
export { AbsoluteGazeSource } from './fallback.js';

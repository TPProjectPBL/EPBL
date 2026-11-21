/**
 * 兼容壳（保留一个版本周期）。
 *
 * 实现已迁到 `shared/gaze/core/`，这里只做 re-export，
 * 保证旧的 import 路径（app.js / gaze-test.html / gaze-online.js）继续可用。
 *
 * 路径层级：lib → air-runner → demo → eye-page-turner → EPBL-latest
 */
export * from '../../../../shared/gaze/core/index.js';

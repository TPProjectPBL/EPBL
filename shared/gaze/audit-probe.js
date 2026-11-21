/* GAZE-AUDIT-PROBE v1
 *
 * 统一标定审计用的只读探针。
 * - 本文件只定义工厂，不主动读取任何页面状态、不修改任何行为。
 * - 页面在自己的脚本作用域内调用 __makeGazeAudit({...})，把局部变量以 getter 形式暴露出来。
 * - 整体关闭：把下面的 GAZE_AUDIT_ENABLED 改成 false（或提前设置 window.__GAZE_AUDIT_OFF = true）。
 *
 * 约定：getter 只允许读值，不允许触发渲染、请求、标定或写 localStorage。
 */
(function () {
  'use strict';

  var GAZE_AUDIT_ENABLED = true;
  window.__GAZE_AUDIT_OFF = !GAZE_AUDIT_ENABLED;
  if (!GAZE_AUDIT_ENABLED) return;

  function safe(fn, fallback) {
    try {
      var v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function point(p) {
    if (!p) return null;
    return {
      x: num(p.x),
      y: num(p.y),
      live: p.live !== false,
      ts: num(p.ts)
    };
  }

  // 模型只返回摘要：绝不把 wx/wy 或样本数组塞进探针输出。
  function modelSummary(m) {
    if (!m) return null;
    return {
      schema: num(m.schema),
      created: num(m.created),
      aspect: num(m.aspect),
      terms: m.terms
        ? { x: (m.terms.x || []).slice(), y: (m.terms.y || []).slice() }
        : null,
      quality: m.quality || null,
      migrated: !!m.migrated
    };
  }

  function qualitySummary(q) {
    if (!q) return null;
    if (Array.isArray(q)) {
      var errs = [];
      for (var i = 0; i < q.length; i++) {
        var r = q[i];
        if (!r) continue;
        var e = num(r.err);
        if (e === null) {
          var tx = num(r.tx), ty = num(r.ty), px = num(r.px), py = num(r.py);
          if (tx !== null && ty !== null && px !== null && py !== null) {
            var dx = px - tx, dy = py - ty;
            e = Math.sqrt(dx * dx + dy * dy);
          }
        }
        if (e !== null) errs.push(e);
      }
      if (!errs.length) return { n: q.length };
      var sum = 0, max = -Infinity;
      for (var j = 0; j < errs.length; j++) {
        sum += errs[j];
        if (errs[j] > max) max = errs[j];
      }
      return { n: errs.length, avg: sum / errs.length, max: max };
    }
    return q;
  }

  window.__makeGazeAudit = function (cfg) {
    return function () {
      return {
        page: cfg.page,
        engine: safe(cfg.engine, null),
        model: modelSummary(safe(cfg.model, null)),
        points: safe(cfg.points, null),
        coord: cfg.coord,
        lastGaze: point(safe(cfg.lastGaze, null)),
        quality: qualitySummary(safe(cfg.quality, null)),
        note: cfg.note || null,
        ts: Date.now(),
        probe: 1
      };
    };
  };
})();

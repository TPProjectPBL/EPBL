/* =====================================================================
   手势分类 + 状态机（抽离自 dual-test/index.html，供控制前端复用）

   - classifyHand：由 21 点手部关键点判断语义手势
   - createGestureStream：把手势流转换为后端所需的 start / hold / end 事件
     手势名已对齐后端协议：scroll-up → four_up，scroll-down → four_down
   ===================================================================== */

export const DEFAULT_PARAMS = {
  fingerRatio: 1.2,
  thumbRatio: 1.25,
  scrollDeadband: 0.12,
  enterFrames: 3,   // 连续多少帧稳定才认为手势“进入”
};

const FINGERS = [
  { tip: 8, mcp: 5 },
  { tip: 12, mcp: 9 },
  { tip: 16, mcp: 13 },
  { tip: 20, mcp: 17 },
];

function d2(lm, a, b) {
  const dx = lm[a].x - lm[b].x;
  const dy = lm[a].y - lm[b].y;
  return Math.hypot(dx, dy);
}

function fingerUp(lm, tip, mcp, r) {
  return d2(lm, tip, 0) > d2(lm, mcp, 0) * r;
}

function thumbUp(lm, r) {
  return d2(lm, 4, 9) > d2(lm, 2, 9) * r;
}

/* 分类器：与 dual-test / controller-demo 逐行一致 */
export function classifyHand(lm, p = DEFAULT_PARAMS) {
  const ext = FINGERS.map((f) => fingerUp(lm, f.tip, f.mcp, p.fingerRatio));
  const n = ext.filter(Boolean).length;
  const th = thumbUp(lm, p.thumbRatio);
  const tipsY = FINGERS.reduce((a, f) => a + lm[f.tip].y, 0) / 4;
  const palmY = lm[9].y;
  const dy = tipsY - palmY;

  if (n === 4) {
    if (dy < -p.scrollDeadband) return { gesture: "scroll-up", feat: { ext, th, dy } };
    if (dy > p.scrollDeadband) return { gesture: "scroll-down", feat: { ext, th, dy } };
    return { gesture: "open", feat: { ext, th, dy } };
  }
  if (n === 0) return { gesture: th ? "thumb" : "fist", feat: { ext, th, dy } };
  if (n === 1 && ext[0]) return { gesture: "point", feat: { ext, th, dy } };
  if (n === 2 && ext[0] && ext[1]) return { gesture: "two", feat: { ext, th, dy } };
  return { gesture: "none", feat: { ext, th, dy } };
}

/* 内部手势名 → 后端协议手势名 */
const GESTURE_MAP = {
  "scroll-up": "four_up",
  "scroll-down": "four_down",
};

/* 手势流：手势“进入”发 start，完全“退出”发 end；持续期间不发重复事件 */
export function createGestureStream(opts = {}) {
  const o = { ...DEFAULT_PARAMS, ...opts };
  const onEvent = o.onEvent || (() => {});

  let cand = null;
  let streak = 0;
  let active = null;

  function emit(name, state) {
    onEvent({ name: GESTURE_MAP[name] || name, state });
  }

  function reset() {
    cand = null;
    streak = 0;
  }

  function push(raw, now) {
    const g = raw || "none";
    if (g === "none") {
      if (active) emit(active, "end");
      active = null;
      reset();
      return;
    }
    if (g === cand) streak++;
    else { cand = g; streak = 1; }
    if (streak < o.enterFrames) return; // 尚未稳定，不切换

    if (g === active) return; // 持续中，不重复发
    if (active) emit(active, "end");
    emit(g, "start");
    active = g;
  }

  return {
    push,
    get active() { return active; },
  };
}

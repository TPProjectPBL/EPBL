/**
 * 就位判定回归测试。
 *
 *   node scripts/test-guide-gate.mjs
 *
 * 覆盖三件曾经出过问题的事：
 *   1. 人退远了框还是绿的（旧实现用绝对 faceH 0.22~0.8）
 *   2. 仰头/低头全部显示「平视」（旧实现用鼻尖-眼中心角度）
 *   3. 偏头、侧脸时要能变红，而不是只有「通过/未通过」两态
 */
import { LIMITS, judgeGuide, canLearnNeutral, stepNeutral } from '../shared/gaze/guide-gate.js';

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

/** 造一个「标准正脸」的 headPose 结果。 */
function head(over = {}) {
  return {
    faceH: 0.5,
    faceW: 0.36,
    cx: 0.5,
    cy: 0.5,
    roll: 0,
    yaw: 0,
    pitchRatio: 0.5,
    ...over,
  };
}

const ctx = { neutral: 0.5 };

console.log('— 距离 —');
check('55cm 正合适', judgeGuide(head(), ctx).dist, 'ok');
check('退远到 1m（faceH 0.30）', judgeGuide(head({ faceH: 0.3 }), ctx).dist, 'bad');
check('退远一档（faceH 0.40）→ 黄', judgeGuide(head({ faceH: 0.4 }), ctx).dist, 'warn');
check('略远（faceH 0.44）仍在容差内', judgeGuide(head({ faceH: 0.44 }), ctx).dist, 'ok');
check('贴到镜头（faceH 0.86）', judgeGuide(head({ faceH: 0.86 }), ctx).dist, 'bad');
check('远端文案', judgeGuide(head({ faceH: 0.3 }), ctx).distText, '太远');

console.log('— 居中 —');
check('正中', judgeGuide(head(), ctx).cen, 'ok');
check('偏右 6cm', judgeGuide(head({ cx: 0.58 }), ctx).cen, 'warn');
check('偏左很远', judgeGuide(head({ cx: 0.3 }), ctx).cen, 'bad');
check('偏上', judgeGuide(head({ cy: 0.35 }), ctx).cenText, '偏上');

console.log('— 姿态 —');
check('歪头 14°', judgeGuide(head({ roll: 14 }), ctx).pose, 'warn');
check('歪头 25°', judgeGuide(head({ roll: 25 }), ctx).pose, 'bad');
check('侧脸 20°', judgeGuide(head({ yaw: 20 }), ctx).pose, 'warn');
check('仰头（pitchRatio 变小到 0.43）', judgeGuide(head({ pitchRatio: 0.43 }), ctx).pose, 'bad');
check('仰头文案', judgeGuide(head({ pitchRatio: 0.43 }), ctx).poseText, '仰头了');
check('低头（pitchRatio 变大到 0.57）', judgeGuide(head({ pitchRatio: 0.57 }), ctx).pose, 'bad');
check('低头文案', judgeGuide(head({ pitchRatio: 0.57 }), ctx).poseText, '低头了');
check('轻微仰头仍是 warn', judgeGuide(head({ pitchRatio: 0.455 }), ctx).pose, 'warn');
check('没有中性值时不拦俯仰', judgeGuide(head({ pitchRatio: 0.8 }), { neutral: null }).pose, 'ok');

console.log('— 综合等级 —');
check('全部合适 → ok', judgeGuide(head(), ctx).level, 'ok');
check('一项 warn → warn', judgeGuide(head({ roll: 14 }), ctx).level, 'warn');
check('一项 bad → bad', judgeGuide(head({ faceH: 0.3, roll: 14 }), ctx).level, 'bad');

console.log('— 中性俯仰学习 —');
check('入场 1 秒内不学', canLearnNeutral(head(), 800), false);
check('入场 2 秒后正脸才学', canLearnNeutral(head(), 2000), true);
check('脸偏时不学', canLearnNeutral(head({ cx: 0.7 }), 2000), false);
check('首次学习=当前值', stepNeutral(null, 0.52), 0.52);
check('轻度漂移', Math.abs(stepNeutral(0.5, 0.51) - 0.5002) < 1e-9, true);
check('大跳变不跟随（可能是动作）', stepNeutral(0.5, 0.62), 0.5);

console.log('— 阈值自洽 —');
check('targetH 是推荐框高度', LIMITS.targetH, 0.5);
check('warn 区间比 ok 宽', LIMITS.distWarn > LIMITS.distOk, true);

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');

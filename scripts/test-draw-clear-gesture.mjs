import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext, Script } from 'node:vm';

for (const page of ['index-3-hand-gazefollower.html', 'index-3-hand.html']) {
  const html = readFileSync(new URL(`../draw/${page}`, import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new Script(script, { filename: page });
  const functions = ['handleHands', 'resetGestureActions', 'updateGestureActions'];
  const separateClearUpdate = script.includes('function updateClear(');
  const update = separateClearUpdate ? 'updateClear' : 'updateUiTargets';
  functions.push(...(separateClearUpdate
    ? ['thumbDirection', update, 'requestClear']
    : [update, 'requestHighCost', 'cancelArmed', 'finishArmed']));
  const kit = script.match(/^  const AirCanvasKit = [\s\S]*?^  \}\)\(\);/m)[0];
  const handlers = functions.map(name => script.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  \\}`, 'm'))[0]);

  function setup() {
    let now = 0;
    let clears = 0;
    const button = { classList: new Set() };
    button.classList.toggle = () => {};
    button.classList.remove = name => button.classList.delete(name);
    const state = { armed: null, strokes: [1] };
    const tipFilter = { filter: value => value };
    const gates = script.match(/^  real\.thumbGate = [^\n]+\n  real\.pointGate = [^\n]+\n  const clearGate = [^\n]+/m)[0];
    const { handleHands, tick } = runInNewContext(`${kit}
      ${gates}
      ${handlers.join('\n')}
      ({ handleHands, tick: ${update} });`, {
      state, real: { fistFrames: 0 }, raw: {}, boardActive: true, HANDEDNESS_FLIP: false,
      CFG: { armMs: Number(script.match(/armMs:\s*(\d+)/)[1]) }, performance: { now: () => now },
      refreshRealStatus: () => {}, toast: () => {}, btnClear: button,
      gazeActive: () => false,
      Input: { penSource: 'gaze' }, clamp01: value => value,
      tipEuroX: tipFilter, tipEuroY: tipFilter, resetTipEuro: () => {},
      btnPalette: button, btnTool: button, btnUndo: button, btnRedo: button,
      btnReset: button, btnSource: button, btnCanvas: button, btnSave: button,
      clearCanvas: () => { clears++; state.strokes.length = 0; },
    });
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    landmarks[0] = { x: 0.5, y: 0.8 };
    landmarks[4] = { x: 0.2, y: 0.5 };
    landmarks[8] = { x: 0.5, y: 0.2 };
    landmarks[20] = { x: 0.8, y: 0.3 };
    function frame(at, category = 'ILoveYou') {
      now = at;
      handleHands(category ? {
        landmarks: [landmarks], gestures: [[{ categoryName: category }]],
        handedness: [[{ categoryName: 'Left' }]],
      } : null, at);
      tick(at);
    }
    return { state, frame, clears: () => clears, tick };
  }

  test(`${page} clears once when a single hand holds 🤟`, () => {
    const board = setup();
    for (let at = 0; at <= 500; at += 50) board.frame(at);
    assert.equal(board.clears(), 0);
    for (let at = 550; at <= 1600; at += 50) board.frame(at);
    assert.equal(board.clears(), 1);
  });

  test(`${page} keeps strokes if the gesture is released or frames stop`, () => {
    for (const release of ['Open_Palm', null, undefined]) {
      const board = setup();
      for (let at = 0; at <= 200; at += 50) board.frame(at);
      assert.ok(board.state.armed);
      if (release !== undefined) {
        board.frame(300, release);
        assert.equal(board.state.armed, null);
      }
      board.tick(700);
      assert.equal(board.state.armed, null);
      assert.equal(board.state.strokes.length, 1);
    }
  });
}

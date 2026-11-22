import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext, Script } from 'node:vm';

for (const page of ['index-3-hand-gazefollower.html', 'index-3-hand.html']) {
  const html = readFileSync(new URL(`../draw/${page}`, import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new Script(script, { filename: page });
  const workbench = page === 'index-3-hand.html';
  const functions = ['handleHands', 'resetGestureActions', 'updateGestureActions'];
  const separateClearUpdate = script.includes('function updateClear(');
  const update = separateClearUpdate ? 'updateClear' : 'updateUiTargets';
  functions.push(...(separateClearUpdate
    ? [update, 'requestClear']
    : [update, 'requestHighCost', 'cancelArmed', 'finishArmed']));
  if (workbench) functions.push('openPalette', 'closePalette', 'selectColor');
  else if (separateClearUpdate) functions.push('thumbDirection');
  const kit = script.match(/^  const AirCanvasKit = [\s\S]*?^  \}\)\(\);/m)[0];
  const handlers = functions.map(name => script.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  \\}`, 'm'))[0]);
  const palette = script.match(/^  const PALETTE = \[[\s\S]*?^  \];/m)[0];

  function setup() {
    let now = 0;
    let clears = 0;
    const button = { classList: new Set() };
    button.classList.toggle = () => {};
    button.classList.remove = name => button.classList.delete(name);
    button.setAttribute = () => {};
    const state = { armed: null, strokes: [1], paletteOpen: false, highlightedIndex: -1 };
    const raw = {};
    const input = { penSource: 'gaze', color: '#ff4d6d', tool: 'pen' };
    const cfg = Object.fromEntries(['armMs', 'paletteConfirmMs', 'paletteFistMaxGapMs'].map(key => [
      key, Number(script.match(new RegExp(`\\b${key}:\\s*(\\d+)`))?.[1]),
    ]));
    const tipFilter = { filter: value => value };
    const gates = script.match(/^  real\.thumbGate = [^\n]+\n  real\.pointGate = [^\n]+\n  const clearGate = [^\n]+/m)[0];
    const { handleHands, tick } = runInNewContext(`${kit}
      ${palette}
      let activeIndex = 0;
      ${gates}
      ${handlers.join('\n')}
      ({ handleHands, tick: ${update} });`, {
      state, real: { fistFrames: 0 }, raw, boardActive: true, HANDEDNESS_FLIP: false,
      CFG: cfg, performance: { now: () => now },
      refreshRealStatus: () => {}, toast: () => {}, btnClear: button,
      gazeActive: () => false,
      Input: input, clamp01: value => value,
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      tipEuroX: tipFilter, tipEuroY: tipFilter, resetTipEuro: () => {},
      btnPalette: button, btnTool: button, btnUndo: button, btnRedo: button,
      btnReset: button, btnSource: button, btnCanvas: button, btnSave: button,
      paletteEl: button, switcherDot: { style: {} }, hudColorDot: { style: {} },
      toggleTool: () => { input.tool = input.tool === 'pen' ? 'eraser' : 'pen'; },
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
    function hold(from, to, gesture) {
      for (let at = from; at <= to; at += 50) frame(at, gesture);
    }
    return { state, raw, input, frame, hold, clears: () => clears, tick };
  }

  if (workbench) {
    test('workbench thumbs move the highlight once per gesture while the palette is open', () => {
      const { state, input, hold } = setup();
      hold(0, 400, 'Thumb_Up');
      assert.equal(state.paletteOpen, true);
      assert.equal(state.highlightedIndex, 0);

      hold(450, 850, 'Thumb_Down');
      assert.equal(state.highlightedIndex, 1);
      assert.equal(input.tool, 'pen');
      assert.equal(input.color, '#ff4d6d');
      hold(900, 1000, 'Open_Palm');
      hold(1050, 1250, 'Thumb_Down');
      assert.equal(state.highlightedIndex, 2);
      hold(1300, 1700, 'Thumb_Up');
      assert.equal(state.highlightedIndex, 1);
      hold(1750, 1850, 'Open_Palm');
      hold(1900, 2000, 'Thumb_Up');
      assert.equal(state.highlightedIndex, 0);
      hold(2050, 2150, 'Open_Palm');
      hold(2200, 2300, 'Thumb_Up');
      assert.equal(state.highlightedIndex, 0);
      assert.equal(state.paletteOpen, true);
    });

    test('workbench confirms after two seconds of fist and waits for release before drawing', () => {
      const { state, raw, input, frame, hold } = setup();
      hold(0, 100, 'Thumb_Up');
      hold(150, 250, 'Thumb_Down');
      hold(300, 2250, 'Closed_Fist');
      assert.equal(state.paletteOpen, true);
      assert.equal(input.color, '#ff4d6d');
      assert.equal(raw.down, false);

      hold(2300, 2650, 'Closed_Fist');
      assert.equal(state.paletteOpen, false);
      assert.equal(input.color, '#ffd166');
      assert.equal(raw.down, false);
      frame(2700, 'Open_Palm');
      hold(2750, 2800, 'Closed_Fist');
      assert.equal(raw.down, true);
      hold(2850, 3100, 'Thumb_Down');
      assert.equal(input.tool, 'eraser');
    });

    test('workbench restarts fist timing after release, hand loss, or missing frames', () => {
      for (const interruption of ['Open_Palm', null, undefined]) {
        const { state, input, frame, hold, tick } = setup();
        hold(0, 100, 'Thumb_Up');
        hold(150, 250, 'Thumb_Down');
        hold(300, 1250, 'Closed_Fist');
        if (interruption === undefined) tick(2300);
        else frame(1300, interruption);
        assert.equal(state.paletteOpen, true);
        const resumedAt = interruption === undefined ? 2350 : 1350;
        hold(resumedAt, resumedAt + 1950, 'Closed_Fist');
        assert.equal(state.paletteOpen, true);
        assert.equal(input.color, '#ff4d6d');
        frame(resumedAt + 2000, 'Closed_Fist');
        assert.equal(state.paletteOpen, false);
        assert.equal(input.color, '#ffd166');
      }
    });
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

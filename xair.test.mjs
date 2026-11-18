import test from "node:test";
import assert from "node:assert/strict";



import { compactInputLabel } from "./web/channel-name.mjs";
import { faderGain, faderMarks, faderPosition, parseFaderGain, xairLayout } from "./web/xair-fader.mjs";

test("AIRCORE resizes the FX area by whole slots and switches to double size above 1200px", () => {
  assert.deepEqual(xairLayout(713, true), { scale: 1, viewport: 713, effects: 135, fader: 220 });
  assert.deepEqual(xairLayout(713, true, 8), { scale: 1, viewport: 713, effects: 135, fader: 212 });
  assert.deepEqual(xairLayout(721, true, 8), { scale: 1, viewport: 721, effects: 135, fader: 220 });
  assert.deepEqual(xairLayout(722, true, 8), { scale: 1, viewport: 722, effects: 149, fader: 207 });
  assert.equal(xairLayout(1200, true).scale, 1);
  assert.deepEqual(xairLayout(1201, true, 8), { scale: 2, viewport: 600.5, effects: 37, fader: 197.5 });
  assert.deepEqual(xairLayout(240, false), { scale: 1, viewport: 240, effects: 37, fader: 96 });
});

test("AIRCORE abbreviates long input labels and keeps channel numbers", () => {
  assert.equal(compactInputLabel("VIRTUAL REC 1/2"), "Rec 1/2");
  assert.equal(compactInputLabel("Analog In 1"), "In 1");
  assert.equal(compactInputLabel("Analog Input 3/4 · USB Audio Interface"), "In 3/4");
  assert.equal(compactInputLabel("USB Microphone 12"), "USB Microphone 12");
  assert.equal(compactInputLabel("No in"), "No in");
  assert.equal(compactInputLabel("Virtualizer 1/2"), "Virtualizer 1/2");
});

test("X AIR taper round-trips gain at every supported tenth of a dB", () => {
  let previous = -1;
  for (let step = -600; step <= 120; step++) {
    const db = step / 10;
    const position = faderPosition(db);
    assert.ok(position > previous);
    assert.equal(faderGain(position), db);
    previous = position;
  }
  assert.equal(faderMarks.find(mark => mark.db === 0).offset, 49 / 179.25);
  assert.equal(parseFaderGain("−7,4 dB", 12), -7.4);
  assert.equal(parseFaderGain("-∞", 12), -60);
  assert.equal(parseFaderGain("0.1", 0), null);
  assert.equal(parseFaderGain("bad", 12), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCentsDeviation,
  classifyPitch,
  getStableSaSuggestion,
  noteNameFromFrequency,
} from "./pitchFeedback.js";

test("calculates cents from the measured and target frequencies", () => {
  assert.ok(
    Math.abs(calculateCentsDeviation(190.9, 240) - -396.3) < 0.1,
  );
});

test("classifies the default target and tolerance", () => {
  assert.equal(classifyPitch(240, 240, 25, 1).state, "correct");
  assert.equal(classifyPitch(239, 240, 25, 1).state, "correct");
  assert.equal(classifyPitch(230, 240, 25, 1).state, "low");
  assert.equal(classifyPitch(250, 240, 25, 1).state, "high");
  for (const cents of [-25, 25]) {
    const frequency = 240 * 2 ** (cents / 1200);
    assert.equal(classifyPitch(frequency, 240, 25, 1).state, "correct");
  }
});

test("adapts classification to a different target and tolerance", () => {
  assert.equal(classifyPitch(432, 432, 15, 1).state, "correct");
  assert.equal(classifyPitch(435, 432, 15, 1).state, "correct");
  assert.equal(classifyPitch(427, 432, 15, 1).state, "low");
});

test("waits for valid, sufficiently confident frequency estimates", () => {
  for (const frequency of [
    undefined,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(classifyPitch(frequency, 240, 25, 1).state, "waiting");
  }
  assert.equal(classifyPitch(240, 240, 25).state, "waiting");
  assert.equal(classifyPitch(240, 240, 25, 0.09).state, "waiting");
  assert.equal(calculateCentsDeviation(240, 0), null);
});

test("suggests a Sa only after enough consistent readings", () => {
  assert.equal(getStableSaSuggestion(Array(23).fill(220)), null);
  assert.equal(getStableSaSuggestion(Array(24).fill(220.34)), 220.3);
  assert.equal(getStableSaSuggestion([220, 221]), null);
  assert.equal(getStableSaSuggestion([...Array(23).fill(220), 230]), null);
});

test("labels a suggested frequency with its nearest standard note", () => {
  assert.equal(noteNameFromFrequency(440), "A4");
  assert.equal(noteNameFromFrequency(220), "A3");
});

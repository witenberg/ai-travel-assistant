import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/prompt.js';

describe('system prompt', () => {
  test('injects the date and the correct weekday', () => {
    // 2026-08-19 is a Wednesday — exactly the case the model previously got wrong.
    const p = buildSystemPrompt(new Date('2026-08-19T10:00:00Z'));
    assert.match(p, /2026-08-19/);
    assert.match(p, /Wednesday/);
  });

  test('the weekday is computed, not hard-coded', () => {
    assert.match(buildSystemPrompt(new Date('2026-08-22T10:00:00Z')), /Saturday/);
  });
});

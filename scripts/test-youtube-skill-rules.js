#!/usr/bin/env node
'use strict';

/**
 * Checks the JavaScript port of the YouTube agent skill tools (hookscore.py, title.py).
 * Expected values were produced by running the original Python tools on the same inputs.
 *
 *   node scripts/test-youtube-skill-rules.js
 */

const assert = require('assert');
const rules = require('../utils/youtube-skill-rules');

const HOOKS = [
  ['97% of the people who start a channel quit before video 30. Here is what the other 3% do differently.', 'The Statistic'],
  ['Your first 30 seconds are why nobody finishes your videos. It is not the topic.', null],
  ['Hey guys welcome back to the channel, today we are talking about something amazing', null]
];

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

check('loads all 21 hook formulas', () => {
  assert.strictEqual(rules.loadHookFormulas().hooks.length, 21);
});

check('a statistic hook is classified and a channel-intro hook ranks last', () => {
  const ranked = rules.rankHooks(HOOKS.map(([text]) => text));
  assert.strictEqual(rules.scoreHook(HOOKS[0][0]).formula, HOOKS[0][1]);
  assert.strictEqual(ranked[ranked.length - 1].hook, HOOKS[2][0]);
  assert.strictEqual(ranked[ranked.length - 1].band, 'WEAK');
});

check('hook verdict is 60% mean + 40% weakest property', () => {
  const scored = rules.scoreHook(HOOKS[1][0]);
  const values = Object.values(scored.properties);
  const expected = Math.round(0.6 * (values.reduce((a, b) => a + b, 0) / values.length) + 0.4 * Math.min(...values));
  assert.strictEqual(scored.verdict, expected);
  assert.ok(rules.HOOK_FIXES[scored.weakest]);
});

check('title lint flags vague, shouting, length and thumbnail duplication', () => {
  const bad = rules.lintTitle('The ULTIMATE AMAZING GUIDE To Everything You Need', 'ULTIMATE GUIDE');
  const codes = bad.issues.map(issue => issue.code);
  for (const code of ['shouting', 'vague', 'no-number', 'duplicate']) assert.ok(codes.includes(code), `missing ${code}`);
  const good = rules.lintTitle('How I Grew 400 to 200,000 Subs in 7 Months', 'ONE FORMAT');
  assert.ok(good.score > bad.score);
  assert.ok(!good.issues.some(issue => issue.code === 'duplicate'));
});

check('matches the Python tools on reference inputs', () => {
  // Values from: python3 hookscore.py --json / python3 title.py --json --thumb "SLEEP LIES"
  assert.strictEqual(rules.scoreHook(HOOKS[0][0]).verdict, 55);
  assert.strictEqual(rules.scoreHook(HOOKS[1][0]).verdict, 57);
  assert.strictEqual(rules.scoreHook(HOOKS[2][0]).verdict, 21);
  assert.strictEqual(rules.scoreHook('The ultimate secret').verdict, 14);
  assert.strictEqual(rules.lintTitle('How I Grew 400 to 200,000 Subs in 7 Months', 'SLEEP LIES').score, 98);
  assert.strictEqual(rules.lintTitle('Why Your Sleep Tracker Is Lying To You?', 'SLEEP LIES').score, 80);
  assert.strictEqual(rules.lintTitle('The ULTIMATE AMAZING GUIDE To Everything You Need', 'SLEEP LIES').score, 52);
});

check('rankTitles drops titles over the 100-character hard limit', () => {
  const ranked = rules.rankTitles(['x'.repeat(101), 'Short title with 3 facts']);
  assert.strictEqual(ranked.length, 1);
});

check('prompt rule blocks carry the skill guidance', () => {
  assert.ok(rules.scriptRules().includes('the-statistic'));
  assert.ok(rules.scriptRules().includes('ONE ask'));
  assert.ok(rules.packagingRules().includes('three words maximum'));
  assert.ok(rules.seoRules().includes('Do NOT write timestamps'));
});

check('voice profile is read from VOICE_PROFILE_PATH', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'voice.md');
  fs.writeFileSync(file, 'Words I never use: unlock');
  const previous = process.env.VOICE_PROFILE_PATH;
  process.env.VOICE_PROFILE_PATH = file;
  try {
    assert.strictEqual(rules.loadVoiceProfile(), 'Words I never use: unlock');
    assert.ok(rules.voiceBlock().includes('unlock'));
  } finally {
    if (previous === undefined) delete process.env.VOICE_PROFILE_PATH;
    else process.env.VOICE_PROFILE_PATH = previous;
  }
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

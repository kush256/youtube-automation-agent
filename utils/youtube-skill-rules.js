'use strict';

/**
 * Editorial rules from the YouTube agent skill pack
 * (https://github.com/Jakeschincariol/youtube-agent-skill, MIT, see vendor/youtube-agent-skill/LICENSE).
 *
 * - scoreHook()/rankHooks() port yt-script/hookscore.py: five properties scored 0-100, verdict is
 *   60% the mean and 40% the weakest property, so one dead property sinks the hook.
 * - lintTitle()/rankTitles() port yt-package/title.py: truncation, vagueness, shouting, missing
 *   number, filler at the front, and title/thumbnail duplication.
 * - The *_RULES strings carry the skills' written guidance into the AI prompts.
 * - loadVoiceProfile() reads the channel's voice.md, which every skill in the pack reads first.
 *
 * Dependency-free on purpose so it can be unit tested without the rest of the app.
 */

const fs = require('fs');
const path = require('path');

const HOOKS_PATH = path.join(__dirname, '..', 'vendor', 'youtube-agent-skill', 'hooks.json');

let cachedHooks = null;
function loadHookFormulas() {
  if (!cachedHooks) {
    const data = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
    cachedHooks = {
      rules: data.rules || [],
      hooks: (data.hooks || []).map(hook => ({
        ...hook,
        patterns: (hook.match || []).map(pattern => new RegExp(pattern, 'i'))
      }))
    };
  }
  return cachedHooks;
}

// ---------------------------------------------------------------------------------------------
// Hook scoring (port of hookscore.py)
// ---------------------------------------------------------------------------------------------

const FILLER = new Set(['basically', 'actually', 'literally', 'just', 'really', 'very', 'so', 'kind', 'sort', 'like',
  'guys', 'hey', 'welcome', 'today', 'video', 'subscribe', 'channel']);
const VAGUE = new Set(['amazing', 'incredible', 'insane', 'crazy', 'huge', 'massive', 'game', 'changer', 'secret',
  'powerful', 'ultimate', 'best', 'revolutionary', 'mind', 'blowing', 'unbelievable']);
const CONCRETE = /\b(\d[\d,.]*\s?(%|k|m|x|s|m|h)?|\$\d|\d+\s?(second|minute|hour|day|week|month|year)s?)\b/gi;
const YOU = /\b(you|your|you're|youre|yourself)\b/gi;
const STAKE = /\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|never|die|dying|dead)\b/gi;
const CURIOSITY = /\b(why|how|what|which|until|before|but|nobody|almost|except|reason|actually)\b/gi;

const clamp = value => Math.max(0, Math.min(100, value));
const count = (regex, text) => (String(text).match(regex) || []).length;
const hookWords = text => String(text).toLowerCase().match(/[a-z0-9'%$.]+/g) || [];

function specificity(text) {
  const words = hookWords(text);
  if (!words.length) return 0;
  const nums = count(CONCRETE, text);
  const vague = words.filter(word => VAGUE.has(word)).length;
  const filler = words.filter(word => FILLER.has(word)).length;
  let score = 34 + nums * 22 - vague * 16 - filler * 5;
  // Proper nouns that are not sentence-initial read as named things.
  const named = text.trim().split(/\s+/).slice(1).filter(word => /^[A-Z]/.test(word)).length;
  score += Math.min(18, 6 * named);
  return clamp(score);
}

function address(text) {
  const first = new RegExp(YOU.source, 'i').test(text.trim().split(/\s+/).slice(0, 6).join(' ')) ? 30 : 0;
  return clamp(26 + count(YOU, text) * 20 + first);
}

function stakes(text) {
  const concrete = new RegExp(CONCRETE.source, 'i').test(text) ? 14 : 0;
  return clamp(22 + count(STAKE, text) * 26 + concrete);
}

function curiosity(text) {
  const question = text.trim().endsWith('?') ? 18 : 0;
  // A hook that resolves itself has no gap left.
  const closed = /\b(because|so that|which means)\b/i.test(text) ? -18 : 0;
  return clamp(24 + count(CURIOSITY, text) * 17 + question + closed);
}

function brevity(text) {
  const n = hookWords(text).length;
  if (n === 0) return 0;
  // 9-24 words is the band a spoken hook lands in at ~150wpm inside 10 seconds.
  if (n >= 9 && n <= 24) return 100;
  if (n < 9) return Math.max(30, 100 - (9 - n) * 11);
  return Math.max(10, 100 - (n - 24) * 7);
}

const HOOK_PROPERTIES = [
  ['SPECIFICITY', specificity],
  ['ADDRESS', address],
  ['STAKES', stakes],
  ['CURIOSITY', curiosity],
  ['BREVITY', brevity]
];

const HOOK_FIXES = {
  SPECIFICITY: 'swap one adjective for a number, a name or a date',
  ADDRESS: "say 'you' in the first six words",
  STAKES: 'name what it costs them to keep doing it the current way',
  CURIOSITY: 'cut the half of the sentence that answers itself',
  BREVITY: '9 to 24 words; read it out loud and stop where you run out of breath'
};

function hookBand(verdict) {
  if (verdict >= 72) return 'STRONG';
  if (verdict >= 55) return 'WORKABLE';
  return 'WEAK';
}

function classifyHook(text) {
  let best = null;
  let hits = 0;
  for (const formula of loadHookFormulas().hooks) {
    const n = formula.patterns.filter(pattern => pattern.test(text)).length;
    if (n > hits) {
      best = formula;
      hits = n;
    }
  }
  return { formula: best ? best.name : 'Unclassified', formulaId: best ? best.id : null, matched: hits };
}

function scoreHook(hookText) {
  const text = String(hookText || '').trim();
  const properties = {};
  for (const [name, fn] of HOOK_PROPERTIES) properties[name] = fn(text);
  const values = Object.values(properties);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const verdict = Math.round(0.6 * mean + 0.4 * Math.min(...values));
  const weakest = Object.keys(properties).reduce((low, key) => (properties[key] < properties[low] ? key : low));
  return {
    hook: text,
    properties,
    verdict,
    band: hookBand(verdict),
    ...classifyHook(text),
    weakest,
    fix: HOOK_FIXES[weakest]
  };
}

function rankHooks(hooks) {
  return (hooks || [])
    .map(hook => (typeof hook === 'object' && hook !== null ? hook.text || hook.hook : hook))
    .map(text => String(text || '').trim())
    .filter(Boolean)
    .map(scoreHook)
    .sort((a, b) => b.verdict - a.verdict);
}

// ---------------------------------------------------------------------------------------------
// Title / thumbnail lint (port of title.py)
// ---------------------------------------------------------------------------------------------

const TITLE_DESKTOP = 60;
const TITLE_MOBILE = 40;
const TITLE_HARD = 100;
const TITLE_VAGUE = new Set(['amazing', 'incredible', 'insane', 'crazy', 'huge', 'massive', 'ultimate', 'best', 'powerful',
  'secret', 'revolutionary', 'mindblowing', 'epic', 'perfect', 'complete', 'everything']);
const TITLE_STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'with', 'your', 'you',
  'my', 'i', 'this', 'that', 'it', 'how', 'what', 'why']);
const titleWords = text => String(text).toLowerCase().match(/[a-z0-9']+/g) || [];

function lintTitle(title, thumbnailText = null) {
  const t = String(title || '').trim();
  const n = t.length;
  const issues = [];
  const good = [];

  if (n > TITLE_HARD) issues.push({ code: 'length', message: `${n} characters - YouTube's hard limit is ${TITLE_HARD}` });
  else if (n > TITLE_DESKTOP) issues.push({ code: 'length', message: `${n} characters - desktop search cuts near ${TITLE_DESKTOP}` });
  else good.push(`${n} characters, inside the ${TITLE_DESKTOP}-character desktop cut`);

  if (n > TITLE_MOBILE) {
    const head = t.slice(0, TITLE_MOBILE).replace(/\s+\S*$/, '');
    issues.push({ code: 'mobile', message: `a mobile feed shows about "${head}..." - check the subject survives` });
  }

  const caps = t.split(/\s+/).filter(word => word.length > 2 && word === word.toUpperCase() && /[A-Z]/.test(word));
  if (caps.length > 2) issues.push({ code: 'shouting', message: `${caps.length} all-caps words - two is the ceiling before it reads as spam` });
  else if (caps.length) good.push(`${caps.length} all-caps word for emphasis`);

  const vague = [...new Set(titleWords(t).filter(word => TITLE_VAGUE.has(word)))].sort();
  if (vague.length) issues.push({ code: 'vague', message: `${vague.join(', ')} - swap for a number, a name or a date` });

  const nums = t.match(/\d[\d,.]*%?/g) || [];
  if (nums.length) good.push(`carries a concrete figure (${nums.slice(0, 3).join(', ')})`);
  else issues.push({ code: 'no-number', message: 'no number, date or name - the most reliable single fix' });

  if (t.endsWith('?')) good.push('open question in the title');

  const front = titleWords(t).slice(0, 3).filter(word => !TITLE_STOP.has(word));
  if (!front.length) issues.push({ code: 'front-load', message: 'the first three words are all filler - move the subject forward' });

  if (thumbnailText) {
    const tw = new Set(titleWords(t).filter(word => !TITLE_STOP.has(word)));
    const shared = [...new Set(titleWords(thumbnailText).filter(word => !TITLE_STOP.has(word) && tw.has(word)))].sort();
    if (shared.length) {
      issues.push({ code: 'duplicate', message: `thumbnail repeats the title on ${shared.join(', ')} - the thumbnail should say what the title does not` });
    } else {
      good.push('thumbnail and title carry different words');
    }
    const thumbWordCount = titleWords(thumbnailText).length;
    if (thumbWordCount > 4) issues.push({ code: 'thumb-length', message: `${thumbWordCount} words on the thumbnail - three is the ceiling at feed size` });
  }

  const score = clamp(100 - 14 * issues.length + 4 * good.length);
  return { title: t, chars: n, score, issues, good };
}

function rankTitles(titles, thumbnailText = null) {
  return (titles || [])
    .map(title => String(title || '').trim())
    .filter(title => title && title.length <= TITLE_HARD)
    .map(title => lintTitle(title, thumbnailText))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------------------------
// Voice profile
// ---------------------------------------------------------------------------------------------

const MAX_VOICE_CHARS = 6000;

function voiceProfileCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [
    process.env.VOICE_PROFILE_PATH,
    path.join(__dirname, '..', 'config', 'voice.md'),
    home && path.join(home, '.claude', 'youtube', 'voice.md')
  ].filter(Boolean);
}

/** Returns the channel's voice.md text (trimmed to keep prompts bounded), or '' when none exists. */
function loadVoiceProfile() {
  for (const candidate of voiceProfileCandidates()) {
    try {
      const text = fs.readFileSync(candidate, 'utf8').trim();
      if (text) return text.length > MAX_VOICE_CHARS ? `${text.slice(0, MAX_VOICE_CHARS)}\n[...truncated]` : text;
    } catch (_error) {
      // Try the next location.
    }
  }
  return '';
}

// ---------------------------------------------------------------------------------------------
// Prompt rule blocks (the skills' written guidance)
// ---------------------------------------------------------------------------------------------

function hookFormulaMenu() {
  return loadHookFormulas().hooks
    .map(hook => `- ${hook.id}: ${hook.shape} Example: "${hook.example}" Fails when: ${hook.fails_when}`)
    .join('\n');
}

const NO_INVENTION_RULE = 'Never invent a number, a result, a person, a channel or a source. If a figure would strengthen a line and it is not in the supplied research, write the line without it.';

function scriptRules() {
  return `SCRIPT RULES (from the yt-script skill):
- The first 15 seconds is the whole job. The hook must confirm the click the title promised, open a question the viewer cannot close, and prove the payoff exists.
- Write FIVE different hook options, each 9-24 spoken words, each using a different formula from the list below. Use "you" early. Prefer a number, a name or a date over any adjective. Do not resolve the question inside the hook.
- The turn (0:15-0:45): one sentence saying what the video is going to do, then start doing it. No channel intro, no "welcome back", no "before we get started", no subscribe pitch here. Those cause the 0:30 drop-off.
- The body: one idea per beat. Every beat has "onScreen": what the viewer SEES during it (a concrete visual, chart, object, place or action), not what is said. A narrated video with nothing to look at is a podcast.
- The payoff: deliver the thing the hook promised, explicitly, and say that you are delivering it.
- The close: ONE ask. Not three.
- Spoken lines are read aloud by a text-to-speech voice: short sentences, plain words, no stage directions, no brackets, no emoji, no markdown inside spoken lines.
- ${NO_INVENTION_RULE}
${loadHookFormulas().rules.map(rule => `- ${rule}`).join('\n')}

HOOK FORMULAS (use the id in "formula"):
${hookFormulaMenu()}`;
}

function packagingRules() {
  return `TITLE AND THUMBNAIL RULES (from the yt-package skill):
- The title and the thumbnail are ONE unit. The thumbnail text must NOT repeat any title word: different words, same promise.
- Thumbnail text: three words maximum.
- Titles: aim for 60 characters or fewer (desktop search cut) and put the subject in the first 40 (mobile feed). Never exceed 100.
- A number, a name or a date beats every adjective. Avoid vague words: amazing, incredible, insane, crazy, huge, massive, ultimate, best, powerful, secret, revolutionary, epic, perfect, complete, everything.
- Two all-caps words is the ceiling. Do not start with filler words.
- ${NO_INVENTION_RULE}`;
}

function seoRules() {
  return `DESCRIPTION AND TAG RULES (from the yt-seo skill):
- First write the three search queries a real person would type that this video should win.
- The title and the first two lines of the description must contain the words in those queries.
- The first two description lines are the only ones most people read (they show above "...more" and are the search snippet): say what the video gives them, in the words they would have typed.
- Then any link or resource. Then the longer version: what is covered, who it is for, what it assumes.
- Do NOT write timestamps or chapters; they are added separately from real timings.
- Tags are a weak signal: use them for disambiguation only (spellings, tool names, abbreviations people type). 15 maximum. No unrelated tags.
- ${NO_INVENTION_RULE}`;
}

function voiceBlock(voiceProfile = loadVoiceProfile()) {
  if (!voiceProfile) return '';
  return `CHANNEL VOICE PROFILE (voice.md). Write in this voice, never use the words it bans, never make the claims it refuses:
"""
${voiceProfile}
"""`;
}

module.exports = {
  loadHookFormulas,
  scoreHook,
  rankHooks,
  hookBand,
  lintTitle,
  rankTitles,
  loadVoiceProfile,
  scriptRules,
  packagingRules,
  seoRules,
  voiceBlock,
  HOOK_FIXES
};

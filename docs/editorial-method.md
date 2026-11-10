# Editorial method: the YouTube agent skill pack

The script, title, thumbnail-text and description writers follow the method of the
[YouTube agent skill pack](https://github.com/Jakeschincariol/youtube-agent-skill) (MIT):
`yt-script` for scripts and hooks, `yt-package` for titles and thumbnails, and `yt-seo` for
descriptions and tags. Its 21 hook formulas are vendored in `vendor/youtube-agent-skill/`, and its
two scoring tools (`hookscore.py` and `title.py`) are ported to JavaScript in
`utils/youtube-skill-rules.js`. The port gives the same scores as the Python originals.

Nothing about review changes. Every video still waits in **Pipeline** for your fact review,
media-rights confirmation and approval before anything is uploaded.

## What each writer does

### Script (`agents/script-writer-agent.js`)

1. Writes **five hooks**, each from a different formula, then scores them with the hook scorer.
   The scorer rates specificity, direct address ("you"), stakes, curiosity and brevity. The
   verdict is 60% the average and 40% the weakest property, so one dead property sinks the hook.
2. If even the best hook is **WEAK** (below 55), it runs one rewrite pass that tells the model
   which property to fix on each hook, then keeps the best hook overall.
3. Replaces the old template intro ("Hey everyone, welcome back to the channel!" plus a
   credibility line) with **the turn**: one sentence saying what the video will do. Channel
   intros at 0:00-0:30 are the most common cause of the 30-second drop-off.
4. Gives every beat an **on-screen** direction (what the viewer sees), and that direction drives
   the scene's image and video prompts.
5. Ends with an explicit **payoff** and **one** call to action, not three.
6. Estimates the runtime from the spoken word count at 150 words per minute.
7. Writes ten title options and three-word thumbnail text as one unit. It keeps the best title
   that does not repeat the thumbnail's words.

In Review Studio, the full script shows the hook's score and formula, the top three hook options,
the thumbnail text and the title's lint result.

### Thumbnail (`agents/thumbnail-designer-agent.js`)

Uses the paired thumbnail text from the script (three words maximum, never repeating the title).
Thumbnail text is now XML-escaped before it goes into the SVG overlay.

### Title, description and tags (`agents/seo-optimizer-agent.js`)

1. Writes the **three search queries** a real person would type to find this video.
2. Picks the final title from the script's title and the new options. It ranks them by the
   title lint plus how many query words each title contains (the yt-seo query test).
3. Writes the description with the first two lines aimed at those queries. Timestamps guessed by
   the model are removed, because chapters must match the rendered audio.
4. Uses up to 15 tags, for disambiguation only.

## Your voice profile

Copy `config/voice.example.md` to `config/voice.md` and fill it in. The script, title and
description writers all read it. The quickest way is to paste the transcripts of three of your
own videos into the "How I actually talk" section. `config/voice.md` is git-ignored.

The writers look for the profile in this order: `VOICE_PROFILE_PATH`, then `config/voice.md`,
then `~/.claude/youtube/voice.md`. The last one is the file the Claude Code skills use, so one
profile can serve both.

## Narration with Gemini TTS

```env
GEMINI_API_KEY=...
TTS_PROVIDER=gemini
GEMINI_TTS_VOICE=Kore
GEMINI_TTS_STYLE=Read this as an energetic, curious storyteller at a brisk pace
```

- `TTS_PROVIDER` pins narration to one provider (`elevenlabs`, `openai` or `gemini`). Without
  it, adding an OpenAI key for scripts would switch narration to OpenAI. If the pinned provider
  is not configured, the default order applies and a warning is logged.
- `GEMINI_TTS_STYLE` is a delivery direction applied to every scene, so separately narrated
  scenes keep one consistent delivery. Listen to the first video before you approve it. If the
  narrator ever reads the direction aloud, shorten it or remove it.

## Upload settings

```env
DEFAULT_PRIVACY_STATUS=private
MADE_FOR_KIDS=false
DEFAULT_CATEGORY_ID=27
DEFAULT_LANGUAGE=en
YOUTUBE_PLAYLIST_ID=PLxxxxxxxx
```

| Setting | Effect |
|---|---|
| `MADE_FOR_KIDS` | YouTube's audience declaration on every upload. Set `true` only if your videos are made for children (COPPA). Default: `false`. |
| `DEFAULT_CATEGORY_ID` | 22 People & Blogs, 27 Education, 28 Science & Technology, 24 Entertainment, 26 Howto & Style, 20 Gaming. Unset: picked from each video's topic. |
| `DEFAULT_LANGUAGE` | The title/description language and the spoken audio language. |
| `YOUTUBE_PLAYLIST_ID` | Every upload is added to this playlist. A playlist error is logged and does not fail the upload. |

The YouTube API cannot set monetization, end screens or cards. Set those once in YouTube Studio
under **Settings → Upload defaults**, and every upload inherits them.

## Testing

```bash
node scripts/test-youtube-skill-rules.js
```

This checks the hook scorer and title lint against values produced by the original Python tools.

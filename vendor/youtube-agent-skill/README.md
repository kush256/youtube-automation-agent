# Vendored: YouTube agent skill pack

`hooks.json` (the 21 hook formulas) is copied unchanged from
https://github.com/Jakeschincariol/youtube-agent-skill (`skills/yt-script/hooks.json`,
commit a2feb2104981a375ffd4f87ee04f4f5344ac43c6), MIT licensed - see `LICENSE` in this folder.

`utils/youtube-skill-rules.js` ports the pack's `hookscore.py` and `title.py` to JavaScript and
carries the written rules of `yt-script`, `yt-package` and `yt-seo` into the AI prompts. Run
`node scripts/test-youtube-skill-rules.js` to check the port.

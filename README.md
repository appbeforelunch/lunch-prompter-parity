# lunch-prompter-parity

A frozen acceptance check for a browser teleprompter. It opens a local web app in headless Chromium (with the browser's built-in test camera) and checks, one by one, the 11 jobs that paid teleprompter apps list in their App Store descriptions. Each job scores **HAVE**, **PARTIAL** or **MISSING** by a rule fixed in advance.

It was written, tested on pages with known answers, and locked (tag `v1-frozen`, sha256 of every file in `HASHES.txt`) **before** the app it scores existed. The rules below could not have been tuned to the result.

By [App Before Lunch](https://github.com/appbeforelunch). MIT licensed.

## Run it

```
npm ci
node parity.mjs path/to/index.html --passes 2 --out parity-runs/run-1
```

Needs Node 20+, `ffmpeg` and `ffprobe` on the PATH (to measure the recorded files), and the Chromium that Playwright 1.63.0 installs (`npx playwright install chromium`). A run takes about 6 minutes per pass. Output: `report.json`, `report.md`, the downloaded recordings, 2x stills and a video of every check (`pass-N/video/J*.webm`, 1920x1080).

Self-test (must be correct on every row before a freeze):

```
node parity.mjs fixture/stub.html   --passes 2 --expect fixture/stub-expected.json     # 6 HAVE / 5 MISSING
node parity.mjs fixture/stub-b.html --passes 2 --expect fixture/stub-b-expected.json   # 7 HAVE / 2 PARTIAL / 2 MISSING, other UI styles
node parity.mjs fixture/stub-c.html --passes 2 --expect fixture/stub-c-expected.json   # 11 HAVE through the harder paths
node parity.mjs fixture/blank.html  --passes 2 --expect fixture/blank-expected.json    # a text box only: 11 MISSING
```

## The pre-registered rules (verbatim)

Headless Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (camera = the browser's test pattern). Each row is HAVE / PARTIAL / MISSING, with the rule fixed now:

| # | Job (from the listings' own feature text) | HAVE if | Source listing |
|---|---|---|---|
| J1 | Write or paste a script | text typed/pasted appears in the prompter view | Tele™ "Script Editor" |
| J2 | Save and reuse scripts | 2 titled scripts survive a page reload | Tele™ "save, and reuse"; Autocue "Unlimited number of scripts" |
| J3 | Smooth auto-scroll | scroll position increases monotonically over 10 s, no jump > 2x median step | Tele™ "Smooth Auto Scrolling" |
| J4 | Adjustable speed | doubling the speed setting gives 1.8-2.2x px/s | all |
| J5 | Play/pause by keyboard | space toggles; scroll stops within 200 ms | PromptSmart remote / Bluetooth keys |
| J6 | Font size | larger setting gives larger computed font-size | Tele™ "Adjustable Text"; Autocue |
| J7 | Mirror mode | prompter text horizontally flipped (computed transform) | all |
| J8 | Countdown before start | a visible 3-2-1 (or any count) before scrolling | common feature |
| J9 | Record video while reading | with the fake camera, a recording of >= 3 s downloads as a playable file (ffprobe duration >= 3 s) | Tele™ "Easy Video Recording"; Autocue |
| J10 | No watermark, no time limit | recorded file has no added overlay text; a 60 s recording works | Autocue's paid features |
| J11 | Works offline | loads and scrolls with the network blocked | ours by design |
| P1 | Voice-following scroll | MISSING by design (excluded from the prompt; PromptSmart says its VoiceTrack is "Patented") | PromptSmart, WarthogLab, Tele™ "auto-read" |
| P2 | Native phone app, text near the lens, PiP floating script | MISSING (browser app) | Tele™ "Floating Script"; PromptSmart "Selfie Mode" |
| P3 | Cloud sync, remote control from a second device | MISSING | PromptSmart |
| P4 | AI script writer, subtitles, background removal | MISSING | WarthogLab, Autocue Video Cue |
| P5 | Support and updates from a developer | MISSING | the paid model |

Headline = count of J1-J11 HAVE, "[H] of 11 jobs". P1-P5 are the honest "what the paid apps still do better" list and are always shown, whatever H is.

One build, one scored run (2 passes, headline = HAVE in both), no re-rolls.

Locating controls without knowing the app: by accessible name / label regex (fixed list per job, e.g. J4 /speed|wpm/i), plus keyboard. A job whose control can't be found by any listed pattern is scored MISSING with reason "not found", then checked by hand once; a hand-found working control is reported as "HAVE (found by hand)", counted, and said in the description.

(Feature names in the "Source listing" column are quoted from public US App Store listings, checked 2026-10-17. They name where each job comes from; this check never runs or scores those apps.)

## How each rule is measured (frozen in v1, before any build)

Where the rules above left a choice, v1 makes it as below. The numbers are constants at the top of `parity.mjs` (`R`, `PAT`).

**Every check** starts in a fresh browser context (empty storage) at 1280x720, loads the page, and puts in a fixed test script (about 1,200 words, no digits, no names) the way a person would: the largest visible text box or editable area (a "new script" control is clicked first if no editor is showing), a title field if there is one (`/title|name/`), the text pasted in (Playwright `fill`), one space typed and deleted, then a Save control if there is one. The first line of every test script is its title. Browser dialogs are accepted; a `prompt()` is answered with the script's title.

**Prompter text** is the displayed element (not a form field or editor) that holds the script's marker word with the largest font size, at least 20 px. **Scroll position** is how far that element has moved up the screen (`-getBoundingClientRect().top`), sampled every animation frame, so it works whether the app scrolls a container, moves the text with a transform, or scrolls the page.

**Starting the scroll** (used by J1, J3-J8, J11): (a) wait 2.5 s in case it scrolls by itself; (b) click a start control (in order: "start/open teleprompter", "start/play/go", "prompter", "present/read/begin/full screen"; never a record, stop, delete, save or settings control); (c) a play control; (d) the space bar. Each step waits up to 8 s. **Scrolling has started** at the first moment the text is at least 10 px higher 1 s later and another 10 px higher 1 s after that (so a view sliding in does not count).

**Finding a control** (speed, text size, mirror, countdown, record): the current view, then again after the pointer moves (toolbars that hide), then inside a settings/options panel, then in the other view (editor or prompter). Setting a value works like a person dragging a slider or picking from a list: the value is set and `input` and `change` events fire. +/- buttons are clicked.

- **J1 HAVE**: after starting, the prompter text shows the typed marker word (displayed, opacity above 0.05).
- **J2**: script A ("Parity Alpha") and script B ("Parity Bravo") are entered (a "new" control first for each, if any), the page is reloaded, then each title is looked for anywhere on the page (list items, buttons, options in a visible list) and clicked or selected. **HAVE**: both titles are listed and each opens its own text. **PARTIAL**: at least one script's text came back. **MISSING**: neither.
- **J3**: a 10 s window starting 1 s after scrolling starts, cut into 0.1 s steps (position interpolated between frames, so a slow test machine does not create jumps). **HAVE**: moved up at least 20 px, no step backwards by more than 1 px, median step above 0, and no step more than 2x the median. **PARTIAL**: moved at least 50 px but failed the smoothness rules. **MISSING**: less.
- **J4**: the speed control's current value is the low setting when doubling it fits the control's range (otherwise the largest value whose double fits; for a list, the two options whose ratio is closest to 2). Speed in px/s is a least-squares fit over 5 s, 1.5 s after starting. The high setting is applied live; if that changes nothing (0.95-1.05x) or stops the text (below 0.2x), it is applied from the editor and the scroll restarted. **HAVE**: px/s ratio within 0.9-1.1x the setting ratio (1.8-2.2x for a doubling). **PARTIAL**: the speed changes, but outside that band. **MISSING**: no control, or no change.
- **J5**: 1.5 s after scrolling starts, space is pressed (focus is taken off a focused button or field first, so space cannot "click" it). **Stopped** = from that moment on the text stays within 1 px of where it ends up, checked for 1 s after a 2 s allowance. **HAVE**: stopped within 200 ms of the key press, and a second space starts it again within 5 s. **PARTIAL**: space stops it, but slower than 200 ms (up to 2 s), or a second space does not restart it. **MISSING**: space does not stop it within 2 s.
- **J6**: the prompter text's computed `font-size`, before and after making the text-size setting larger (slider or number: up by half its value, at least one step; list: the next larger option; +/- buttons: "+" three times). **HAVE**: at least 1 px larger. **MISSING** otherwise.
- **J7**: the combined `transform`, `scale` and `rotate` of the prompter text and every parent, before and after using the mirror control. Flipped left to right = the combined matrix has a negative horizontal scale and a positive vertical scale (upside down does not count). **HAVE**: the control switches the text between flipped and not flipped. **MISSING** otherwise. The report also records whether the letters' on-screen order is reversed, as a cross-check.
- **J8**: while starting, every frame records short texts (24 characters or fewer) that hold exactly one whole number from 1 to 10 and were not on screen before the start. **HAVE**: at least two different numbers, counting down, before scrolling starts. If none is seen, a countdown control (`/countdown|delay|timer/`) is turned on (a checkbox ticked, or the value 3) and the start is tried once more. **MISSING** otherwise.
- **J9**: click record ("start recording" or a record symbol first, then any "record" control). If the browser's recorder has not started within 8 s, the camera control is clicked once and record tried again, then up to two other record controls. Record 5 s, stop (a "stop recording" control first, then any "stop", then "finish/done"; if the recorder is still running, the record control that started it is clicked again), then take the downloaded file (automatic within 8 s, or a download, then save-video/export, then save control). **Duration** = ffprobe's format duration, or for WebM files from the browser's recorder, which have none, the last packet's time. **Playable** = ffmpeg decodes the video with no error and at least one frame. **HAVE**: playable and at least 3 s. **PARTIAL**: a file downloads but fails one of those. **MISSING**: no file.
- **J10**: the same, recording 63 s. **No added overlay**: the browser's test camera draws only greens (and its own clock text, also green), so one frame per second is checked for pixels that are neither green-dominant (green at least 40 above red and blue) nor near-black (all channels under 48). An overlay is present if such pixels cover more than 0.01% of the frame in at least half of the frames. (On the raw test camera this count is 0.) **HAVE**: at least 60 s and no overlay. **PARTIAL**: one of the two. **MISSING**: neither, or no recording. The frame with the most off-palette pixels is saved for checking by eye.
- **J11**: its own browser context set offline, with every request that is not `file:`, `data:` or `blob:` aborted. **HAVE**: the script goes in and the text scrolls. **MISSING** otherwise.

**Rows and headline**: each row reports the lower of its two passes (HAVE above PARTIAL above MISSING). H = rows that are HAVE in both passes. Network requests the app makes in the other checks are listed in the report (the app is asked to make none).

**Misreads**: every row's evidence (stills, the check's video, the measured numbers) is kept. Any row that looks wrong on review is reported as a possible misread next to the headline, not changed.

### Known limits

- Controls wired only to a plain `<div>` with no role, label, `tabindex` or `onclick` cannot be found by name (the same controls a keyboard or screen-reader user cannot reach). They score "not found" and get the hand check.
- Text drawn on a `<canvas>` instead of HTML cannot be read, so the text-based jobs would score MISSING.
- A countdown shown only as an image or CSS-generated content is not read (J8).
- The overlay rule (J10) only sees overlays that are not green or black, and would also flag a grey border or frame drawn around the camera.

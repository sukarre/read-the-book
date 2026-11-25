# Read the Book

Open a PDF, Word file, text file, photo or scan, and have it read aloud in a calm, natural voice.

- **Page view**: the original pages, figures and charts exactly as printed, with the sentence being read highlighted on the page. Click anywhere on a page to read from there.
- **Text view**: clean reflowed text with figures cropped from the page, inline.
- **Figure links**: "Figure 3.1" in the text is a link; clicking it opens the figure beside the text (a bottom sheet on phones), with a button to jump to its page.
- Reads only the prose: running headers, page numbers, chart labels, axis numbers and image credits are skipped; sentences that continue across pages or around figures are joined.
- Remembers the document and where you stopped.

One codebase runs on Windows/Mac (browser or installed app) and Android (installed from Chrome).

## Run it on this PC

```powershell
python devserver.py
```

(`devserver.py` is `python -m http.server` with caching turned off, so code changes show on reload.)

Then open **http://localhost:5173 in Microsoft Edge**. Edge has free Microsoft "Natural" neural voices
(Aria, Jenny, Ava, Emma, Neerja and others), which are the smoothest free voices available.
Chrome only has its Google voices, and other browsers have only the older, robotic system voices.
Click **Install app** in the header (or the install icon in Edge's address bar) to get a desktop app window.

## Put it on Android

Android needs the app served over HTTPS. The simplest free option is GitHub Pages:
push this folder to a GitHub repo, enable Pages, and open the URL in Chrome on the phone
→ menu → **Add to Home screen / Install app**.
For the best voice: Android Settings → Text-to-speech → engine **Speech Services by Google** → install a high-quality voice.

## Android app (APK)

The APK wraps the same web app with Capacitor and adds a small native plugin
(`android/app/src/main/java/io/github/sukarre/readthebook/`):

- speaks with Android's own text-to-speech (Google voices; Android's WebView has no web voices),
- keeps reading with the screen off (foreground media service + wake lock, sentences queued ahead in the engine),
- shows a notification with Pause / Play / Stop, also on the lock screen,
- pauses for phone calls and other audio (audio focus), and resumes from the same word.

Build it (needs Node.js and Android Studio; uses Android Studio's bundled Java):

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
npm install
npm run apk
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.
Install it on the phone: copy the file over (USB, Drive, email to yourself), open it, and allow
"Install unknown apps" for the app you opened it from.
It is signed with this PC's debug key (`%USERPROFILE%\.android\debug.keystore`): later builds from the same PC
install over it and keep your data; builds signed with another key must be uninstalled first.

`npm run apk` copies the web files into `www/` (`scripts/copy-web.mjs`); edit the files in the repo root, not in `www/`.

## What it reads

| Input | How |
|---|---|
| PDF with text | pdf.js text extraction |
| Scanned PDF | pages with no text are rendered and OCR'd (Tesseract) |
| Word `.docx` | mammoth.js (old `.doc` is not supported: re-save as .docx) |
| Photos / camera scans | Tesseract OCR; pick several photos to read them as consecutive pages |
| `.txt` / pasted text | as is |

OCR languages: English, Hindi, Telugu, Tamil, Kannada, Malayalam, Marathi, Bengali, Gujarati, Spanish, French, German
(set under voice settings → Language; this also filters the voice list).

Everything runs on the device; documents are never uploaded. An internet connection is needed the first time
to download the libraries and OCR language data, which are then cached.

## Files

- `index.html`, `styles.css`: UI
- `app.js`: wiring, settings, saved position
- `extract.js`: PDF / DOCX / image / OCR extraction, page layout, figure and caption detection
- `segment.js`: sentence splitting with positions
- `reader.js`: voice ranking, speech playback
- `private/`: your own books for testing (git-ignored, never published)
- `sw.js`, `manifest.webmanifest`, `icons/`: installable PWA and offline support
- `native.js`: speech backend for the Android app (talks to the native ReadAloud plugin)
- `android/`, `capacitor.config.json`, `package.json`, `scripts/`: Android app build
- `test/`: sample files for every input type

## Known limits

- Figure detection is heuristic. It handles images, charts drawn with text (e.g. Market Profile letter grids)
  and vector charts that have a caption; a vector chart with no caption shows in page view but not in text view.
- Opening a long book takes a while the first time (about 20 seconds for a 225-page book); after that it opens instantly.
- **Android screen lock (web version only)**: in Chrome, speech stops when the screen turns off or you leave the app.
  The APK keeps reading.
- **Voice quality depends on the device's voices.** For studio-grade voices on every device, add a cloud
  text-to-speech engine (Azure Neural, Google, ElevenLabs). That costs money per character and sends text to that service.

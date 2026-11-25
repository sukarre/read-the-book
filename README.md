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
- `test/`: sample files for every input type

## Known limits

- Figure detection is heuristic. It handles images, charts drawn with text (e.g. Market Profile letter grids)
  and vector charts that have a caption; a vector chart with no caption shows in page view but not in text view.
- Opening a long book takes a while the first time (about 20 seconds for a 225-page book); after that it opens instantly.
- **Android screen lock**: browser speech stops when the screen turns off or you leave the app. Fixing this requires
  wrapping the app as a native APK (Capacitor) with a foreground audio service.
- **Voice quality depends on the device's voices.** For studio-grade voices on every device, add a cloud
  text-to-speech engine (Azure Neural, Google, ElevenLabs). That costs money per character and sends text to that service.

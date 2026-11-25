// Android app (Capacitor) speech backend.
// Android's WebView has no Web Speech voices, so in the APK the app talks to a small native
// plugin (ReadAloud, see android/app/src/main/java/.../ReadAloudPlugin.java) that speaks with
// Android's text-to-speech engine inside a foreground media service. Reading therefore continues
// with the screen off, and a notification offers Pause / Play.
// In a normal browser this module does nothing and reader.js is used instead.

export const isNative = !!window.Capacitor?.isNativePlatform?.();

// Capacitor plugin objects are proxies that answer to any method name, including then(),
// so they must never be returned from an async function or awaited. Keep them in a box.
let boxPromise = null;
function getPlugin() {
  boxPromise ||= import('./vendor/capacitor-core.js').then(({ registerPlugin }) => ({ api: registerPlugin('ReadAloud') }));
  return boxPromise;
}

export async function getNativeVoices() {
  const p = (await getPlugin()).api;
  try {
    const { voices } = await p.getVoices();
    return voices || [];
  } catch (e) {
    console.warn('No Android voices', e);
    return [];
  }
}

export async function openVoiceSettings() {
  const p = (await getPlugin()).api;
  return p.openTtsSettings().catch(() => {});
}

// Same interface as Reader in reader.js.
export class NativeReader {
  constructor({ onSentence = () => {}, onState = () => {}, onEnd = () => {} } = {}) {
    this.sentences = [];
    this.index = 0;
    this.offset = 0;
    this.playing = false;
    this.voice = null;
    this.rate = 0.95;
    this.pitch = 1;
    this.onSentence = onSentence;
    this.onState = onState;
    this.onEnd = onEnd;
    this.ready = this.attach();
  }

  get supported() { return true; }

  async attach() {
    const b = await getPlugin();
    const p = b.api;
    await p.addListener('sentence', ({ index }) => {
      this.index = index; this.offset = 0; this.onSentence(index);
    });
    await p.addListener('range', ({ index, start }) => {
      if (index === this.index) this.offset = start;
    });
    // The notification button, audio focus loss (a phone call) or the system can stop or start speech.
    await p.addListener('state', ({ playing, index, offset }) => {
      if (typeof index === 'number') this.index = index;
      if (typeof offset === 'number') this.offset = this.wordStart(offset);
      if (playing !== this.playing) { this.playing = playing; this.onState(playing); }
    });
    await p.addListener('end', () => {
      this.playing = false; this.offset = 0; this.onState(false); this.onEnd();
    });
    return b;
  }

  wordStart(o) {
    const t = this.sentences[this.index] || '';
    o = Math.min(Math.max(0, o || 0), t.length);
    while (o > 0 && !/\s/.test(t[o - 1])) o--;
    return o;
  }

  async load(sentences, startAt = 0) {
    this.stop();
    this.sentences = sentences;
    this.index = Math.min(Math.max(0, startAt), Math.max(0, sentences.length - 1));
    this.offset = 0;
    this.onSentence(this.index);
    const p = (await this.ready).api;
    await p.setText({ sentences });
  }

  async play(from = this.index, offset = 0) {
    if (!this.sentences.length) return;
    this.index = Math.min(Math.max(0, from), this.sentences.length - 1);
    this.offset = offset;
    this.playing = true;
    this.onState(true);
    this.onSentence(this.index);
    const p = (await this.ready).api;
    p.start({
      index: this.index, offset: this.offset,
      voice: this.voice?.voiceURI || null, rate: this.rate, pitch: this.pitch,
      title: document.title.replace(/ · Read the Book$/, ''),
    }).catch((e) => { console.warn('Speech failed', e); this.playing = false; this.onState(false); });
  }

  resume() { this.play(this.index, this.offset); }

  async pause() {
    if (!this.playing) return;
    this.playing = false;
    this.onState(false);
    const p = (await this.ready).api;
    const r = await p.stop().catch(() => null);
    if (r && r.index === this.index) this.offset = this.wordStart(r.offset);
  }

  stop() {
    this.playing = false;
    this.offset = 0;
    this.onState(false);
    this.ready.then((b) => b.api.stop()).catch(() => {});
  }

  toggle() { this.playing ? this.pause() : this.resume(); }

  seek(i) {
    i = Math.min(Math.max(0, i), this.sentences.length - 1);
    if (this.playing) this.play(i);
    else { this.index = i; this.offset = 0; this.onSentence(i); }
  }

  next() { this.seek(this.index + 1); }
  prev() { this.seek(this.index - 1); }

  setVoice(v) { this.voice = v; this.restartIfPlaying(); }
  setRate(r) { this.rate = r; this.restartIfPlaying(); }
  setPitch(p) { this.pitch = p; this.restartIfPlaying(); }
  restartIfPlaying() { if (this.playing) this.play(this.index, this.wordStart(this.offset)); }

  async preview(text) {
    await this.pause();
    const p = (await this.ready).api;
    p.preview({ text, voice: this.voice?.voiceURI || null, rate: this.rate, pitch: this.pitch }).catch(() => {});
  }
}

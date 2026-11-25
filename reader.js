// Read-aloud engine built on the Web Speech API.
// Speaks one sentence at a time: this avoids Chrome's cut-off on long utterances,
// enables highlighting, and makes pause/resume reliable on Android.

// ---------- Voices ----------
const WARM_VOICES = /aria|jenny|emma|ava|sonia|libby|natasha|neerja|swara|shruti|michelle|ana\b|clara|aditi|kajal|heera|serena|samantha|karen|moira|tessa/i;

export function voiceScore(v) {
  // Android voices from the native plugin carry Android's quality rating (500 very high, 400 high).
  if (typeof v.quality === 'number') return (v.quality >= 400 ? 100 : 30) + (v.network ? 0 : 5) + (v.default ? 3 : 0);
  const n = v.name;
  let s = 0;
  if (/natural/i.test(n)) s += 100;          // Microsoft Edge neural voices
  if (/neural|premium|enhanced|wavenet/i.test(n)) s += 80;
  if (/google/i.test(n)) s += 45;            // Google voices (Chrome / Android)
  if (WARM_VOICES.test(n)) s += 15;
  if (/desktop|espeak|robot|novelty|zarvox|whisper|bad news|bells|bubbles|cellos|organ/i.test(n)) s -= 60;
  if (v.default) s += 3;
  return s;
}

export function isNaturalVoice(v) { return voiceScore(v) >= 45; }

export function getVoices() {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve([]);
    let voices = synth.getVoices();
    if (voices.length) return resolve(voices);
    const done = () => { synth.removeEventListener('voiceschanged', done); resolve(synth.getVoices()); };
    synth.addEventListener('voiceschanged', done);
    setTimeout(done, 2500); // some browsers never fire the event
  });
}

// ---------- Player ----------
export class Reader {
  constructor({ onSentence = () => {}, onState = () => {}, onEnd = () => {} } = {}) {
    this.synth = window.speechSynthesis;
    this.sentences = [];
    this.index = 0;
    this.playing = false;
    this.voice = null;
    this.rate = 0.95;
    this.pitch = 1;
    this.gen = 0;          // increments on every start/stop so stale callbacks are ignored
    this.current = null;   // keep a reference: Chrome can garbage-collect utterances mid-speech
    this.onSentence = onSentence;
    this.onState = onState;
    this.onEnd = onEnd;
  }

  get supported() { return !!this.synth; }

  load(sentences, startAt = 0) {
    this.stop();
    this.sentences = sentences;
    this.index = Math.min(Math.max(0, startAt), Math.max(0, sentences.length - 1));
    this.offset = 0;
    this.onSentence(this.index);
  }

  // play() starts the sentence at `from` from its beginning.
  // resume() continues the current sentence from the word where it was paused.
  play(from = this.index, offset = 0) {
    if (!this.sentences.length || !this.synth) return;
    this.index = Math.min(Math.max(0, from), this.sentences.length - 1);
    this.offset = offset;
    this.playing = true;
    this.onState(true);
    this.synth.cancel();
    const gen = ++this.gen;
    // A short delay after cancel() avoids a Chrome/Edge bug where the next speak() is dropped.
    setTimeout(() => { if (gen === this.gen) this.speakCurrent(gen); }, 80);
  }

  resume() { this.play(this.index, this.offset || 0); }

  speakCurrent(gen, retry = 0) {
    const full = this.sentences[this.index];
    const base = Math.min(this.offset || 0, full.length);
    const text = full.slice(base);
    this.onSentence(this.index);
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; }
    u.rate = this.rate;
    u.pitch = this.pitch;
    let started = false;
    u.onstart = () => { started = true; };
    // Remember how far we got, so pause → play continues from this word, not the sentence start.
    u.onboundary = (e) => {
      started = true;
      if (gen === this.gen && e.name !== 'sentence') this.offset = base + e.charIndex;
    };
    u.onend = () => {
      if (gen !== this.gen) return;
      this.advance(gen);
    };
    u.onerror = (e) => {
      if (gen !== this.gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') {
        // Not cancelled by us (that bumps gen first): the system stopped speech
        // (screen lock, another app, Edge dropping it). Show it as paused so the
        // button state matches what you hear and one tap resumes.
        this.gen++;
        this.playing = false;
        this.onState(false);
        return;
      }
      console.warn('Speech error', e.error, 'on sentence', this.index);
      this.advance(gen);
    };
    this.current = u;
    this.synth.speak(u);
    // Watchdog: Edge's online "Natural" voices sometimes silently drop an utterance after
    // cancel(). If nothing started within a few seconds, speak it again (once or twice).
    setTimeout(() => {
      if (gen !== this.gen || started || this.current !== u) return;
      if (retry >= 2) { console.warn('Speech did not start'); this.pause(); return; }
      this.synth.cancel();
      setTimeout(() => { if (gen === this.gen) this.speakCurrent(gen, retry + 1); }, 80);
    }, 4000);
  }

  advance(gen) {
    this.offset = 0;
    if (this.index < this.sentences.length - 1) {
      this.index++;
      // Small natural pause between sentences.
      setTimeout(() => { if (gen === this.gen) this.speakCurrent(gen); }, 120);
    } else {
      this.playing = false;
      this.gen++;
      this.onState(false);
      this.onEnd();
    }
  }

  // cancel() instead of speechSynthesis.pause(): pause() is broken on Android Chrome
  // and unreliable with Edge's online voices. The word offset makes resume seamless anyway.
  pause() {
    if (!this.playing) return;
    this.gen++;
    this.playing = false;
    this.synth.cancel();
    // Back up to the start of the word that was being spoken.
    const t = this.sentences[this.index] || '';
    let o = Math.min(this.offset || 0, t.length);
    while (o > 0 && !/\s/.test(t[o - 1])) o--;
    this.offset = o;
    this.onState(false);
  }

  stop() {
    this.gen++;
    this.playing = false;
    if (this.synth) this.synth.cancel();
    this.onState(false);
  }

  toggle() { this.playing ? this.pause() : this.resume(); }

  seek(i) {
    i = Math.min(Math.max(0, i), this.sentences.length - 1);
    if (this.playing) this.play(i);
    else { this.index = i; this.offset = 0; this.onSentence(i); }
  }

  next() { this.seek(this.index + 1); }
  prev() { this.seek(this.index - 1); }

  // Settings changes take effect from the current sentence.
  setVoice(v) { this.voice = v; this.restartIfPlaying(); }
  setRate(r) { this.rate = r; this.restartIfPlaying(); }
  setPitch(p) { this.pitch = p; this.restartIfPlaying(); }
  restartIfPlaying() { if (this.playing) this.play(this.index, this.offset || 0); }

  preview(text) {
    this.pause();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; }
    u.rate = this.rate; u.pitch = this.pitch;
    this.current = u;
    this.synth.speak(u);
  }
}

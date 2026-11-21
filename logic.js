// Compact Mixer: logic with no DOM, so tests can exercise it against Luna.MockEngine.
//
// Functions take SDK objects (a Luna.Session, a Luna.Track or Luna.Bus) and return plain data,
// or perform an engine action. main.js turns the data into strips.

const KINDS = ['audio', 'instrument', 'bus', 'cue'];
/** Kinds shown until the user changes the filter: cue mixes stay out of the way. */
const DEFAULT_KINDS = ['audio', 'instrument', 'bus'];

const AddOnLogic = {
  KINDS,
  DEFAULT_KINDS,

  /**
   * 'master', 'folder', 'bus', 'cue', 'other', 'audio' or 'instrument'. Cue covers LUNA's cue,
   * headphone and talkback buses; 'other' (input, loopback) is never shown. MIDI matrix and
   * video tracks count as audio.
   */
  kindOf(ch) {
    if (ch instanceof Luna.Bus) {
      if (ch.isMaster) return 'master';
      const type = String(ch.busType.value ?? 'aux');
      if (type.startsWith('cue') || type === 'headphone' || type === 'talkback') return 'cue';
      if (type !== 'aux') return 'other';
      return ch.isFolder ? 'folder' : 'bus';
    }
    return ch.trackType.value === 'instrument' ? 'instrument' : 'audio';
  },

  /** The filter group a kind belongs to: folders filter with buses. */
  filterKind(kind) {
    return kind === 'folder' ? 'bus' : kind;
  },

  /** A packed ARGB colour (fact 27) as #rrggbb, or null when the channel has none. */
  cssColor(argb) {
    return typeof argb === 'number' ? `#${(argb & 0xffffff).toString(16).padStart(6, '0')}` : null;
  },

  /** Plain data for one channel. */
  info(ch) {
    return {
      id: ch.id,
      name: ch.name.value ?? ch.id,
      kind: AddOnLogic.kindOf(ch),
      color: AddOnLogic.cssColor(ch.color.value),
    };
  },

  /**
   * Every channel the mixer can show, in LUNA's own order (tracks, buses and folders mixed as
   * LUNA lists them, each folder followed by its contents), then cue mixes, then the master
   * last. LUNA's click and count-in tracks are left out.
   */
  channels(session) {
    const all = session.channelsInOrder.filter((ch) => !(ch instanceof Luna.Track) || !['click', 'count_in'].includes(ch.trackType.value));
    const kind = (ch) => AddOnLogic.kindOf(ch);
    return [
      ...all.filter((ch) => !['master', 'cue'].includes(kind(ch))),
      ...all.filter((ch) => kind(ch) === 'cue'),
      ...all.filter((ch) => kind(ch) === 'master'),
    ];
  },

  // ---- Moving a channel left or right, in LUNA's own order -----------------------------------

  /** Tracks, buses and folders can move; the master, cue mixes and system tracks cannot. */
  movable(ch) {
    if (ch instanceof Luna.Track && ['click', 'count_in'].includes(ch.trackType.value)) return false;
    return !['master', 'cue', 'other'].includes(AddOnLogic.kindOf(ch));
  },

  /**
   * Where `ch` goes to step once left (`dir` −1) or right (+1) past its neighbour among its
   * siblings (same folder; LUNA keeps each folder's contents together), counting only
   * siblings in `shownIds` when given, so a filtered view steps past what it shows. Returns
   * `{ after }` (a channel, or null for first) for Session.reorder, or null when it is
   * already at that end.
   */
  moveTarget(session, ch, dir, shownIds = null) {
    const folder = ch.folderUid.value ?? null;
    const sibs = session.channelsInOrder.filter((c) => AddOnLogic.movable(c) && (c.folderUid.value ?? null) === folder);
    const i = sibs.indexOf(ch);
    if (i < 0) return null;
    const shown = (c) => !shownIds || shownIds.has(c.id);
    if (dir < 0) {
      let p = i - 1;
      while (p >= 0 && !shown(sibs[p])) p--;
      if (p < 0) return null;
      return { after: p > 0 ? sibs[p - 1] : null };
    }
    let n = i + 1;
    while (n < sibs.length && !shown(sibs[n])) n++;
    if (n >= sibs.length) return null;
    return { after: sibs[n] };
  },

  /** Move `ch` one step left or right in LUNA (one undo step). Resolves false when it cannot. */
  async move(session, ch, dir, shownIds = null) {
    const target = AddOnLogic.moveTarget(session, ch, dir, shownIds);
    if (!target) return false;
    await session.reorder([ch], { after: target.after });
    return true;
  },

  /** The bar the playhead is in, from LUNA's location push; 1 until known. */
  currentBar(transport) {
    return transport.location.value?.bar_beat?.bar ?? 1;
  },

  /** An empty filter: shows everything. */
  emptyFilter() {
    return { query: '', kinds: [...DEFAULT_KINDS], color: null };
  },

  /** True when the filter hides nothing. */
  isEmptyFilter(f) {
    return !f.query.trim() && f.color === null && KINDS.every((k) => f.kinds.includes(k) === DEFAULT_KINDS.includes(k));
  },

  /**
   * Does a channel pass the filter? `query` is matched case-insensitively against the name;
   * commas separate alternatives ("vox, gtr" shows both). The master always passes, so the
   * main output stays in reach whatever is filtered.
   */
  matches(info, filter) {
    if (info.kind === 'master') return true;
    if (info.kind === 'other') return false;
    if (!filter.kinds.includes(AddOnLogic.filterKind(info.kind))) return false;
    if (filter.color !== null && info.color !== filter.color) return false;
    const terms = filter.query.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
    if (terms.length === 0) return true;
    const name = info.name.toLowerCase();
    return terms.some((t) => name.includes(t));
  },

  /** The channels that pass `filter`, as SDK objects, in order. */
  filtered(session, filter) {
    return AddOnLogic.channels(session).filter((ch) => AddOnLogic.matches(AddOnLogic.info(ch), filter));
  },

  /**
   * The distinct colours of the channels whose kind the filter shows, in first-seen order, for
   * the colour buttons. Hidden kinds (cue mixes, by default) add no colour of their own.
   */
  colors(session, kinds = DEFAULT_KINDS) {
    const seen = [];
    for (const ch of AddOnLogic.channels(session)) {
      const c = AddOnLogic.cssColor(ch.color.value);
      if (c && kinds.includes(AddOnLogic.filterKind(AddOnLogic.kindOf(ch))) && !seen.includes(c)) seen.push(c);
    }
    return seen;
  },

  /** The solo control of a channel, or undefined when it has none (the master). */
  soloOf(ch) {
    return ch.controls.byId('solo') ? ch.controls.get('solo') : undefined;
  },

  /** The mute control of a channel's main output, or undefined. */
  muteOf(ch) {
    return ch.main.controls.byId('mute') ? ch.mute : undefined;
  },

  /** How many channels are soloed and muted, for the header buttons. */
  counts(session) {
    let soloed = 0;
    let muted = 0;
    for (const ch of AddOnLogic.channels(session)) {
      if (AddOnLogic.soloOf(ch)?.on) soloed++;
      if (AddOnLogic.muteOf(ch)?.on) muted++;
    }
    return { soloed, muted };
  },

  /** Clear every solo in the session, as one undo step. */
  async clearSolos(session) {
    await session.transaction('Clear all solos', async () => {
      for (const ch of AddOnLogic.channels(session)) {
        const solo = AddOnLogic.soloOf(ch);
        if (solo?.on) await solo.real.set(false);
      }
    });
  },

  /** Unmute every channel in the session, as one undo step. */
  async unmuteAll(session) {
    await session.transaction('Unmute all', async () => {
      for (const ch of AddOnLogic.channels(session)) {
        const mute = AddOnLogic.muteOf(ch);
        if (mute?.on) await mute.real.set(false);
      }
    });
  },

  // ---- The meter: an audio scale, as LUNA's own meters draw it ---------------------------------

  /** The gain fader's taper (LUNA's dB ↔ position table), for the fader line only. */
  taperOf(ch) {
    return ch.gain.taper.value ?? Luna.Taper.named('');
  },

  /**
   * A meter level in dBFS. The SDK documents levels as 0..1 with 1 at full scale; this reads
   * them as linear amplitude (0.5 ≈ −6 dBFS), as Luna.waveformPeak does for clip peaks.
   */
  levelDb(level) {
    return level > 0 ? 20 * Math.log10(level) : -Infinity;
  },

  /**
   * LUNA's meter scale: 0 dBFS at the top, then these marks evenly spaced down the meter (as on
   * LUNA's mixer: 3 dB steps to −21, then −27, −36, −46, −60), and silence at the bottom.
   */
  METER_MARKS: [0, -3, -6, -9, -12, -15, -18, -21, -27, -36, -46, -60],
  METER_FLOOR_DB: -80,

  /** Where a level in dBFS sits on the meter, 0 at the bottom and 1 (0 dBFS and above) at the top. */
  meterPos(db) {
    const M = AddOnLogic.METER_MARKS;
    const step = 1 / M.length;                   // −60 sits one step above the bottom
    if (!(db > AddOnLogic.METER_FLOOR_DB)) return 0;
    if (db >= 0) return 1;
    if (db <= M.at(-1)) return step * (db - AddOnLogic.METER_FLOOR_DB) / (M.at(-1) - AddOnLogic.METER_FLOOR_DB);
    for (let i = 0; i < M.length - 1; i++) {
      if (db <= M[i] && db >= M[i + 1]) {
        const top = 1 - i * step;
        return top - step * (M[i] - db) / (M[i] - M[i + 1]);
      }
    }
    return 0;
  },

  /** The dBFS at meter position `pos` (the inverse of meterPos), −Infinity at the bottom. */
  meterDb(pos) {
    if (pos <= 0) return -Infinity;
    if (pos >= 1) return 0;
    const M = AddOnLogic.METER_MARKS;
    const step = 1 / M.length;
    if (pos <= step) return AddOnLogic.METER_FLOOR_DB + (pos / step) * (M.at(-1) - AddOnLogic.METER_FLOOR_DB);
    const i = Math.min(M.length - 2, Math.floor((1 - pos) / step));
    const top = 1 - i * step;
    return M[i] - ((top - pos) / step) * (M[i] - M[i + 1]);
  },

  /** Where a meter level (0..1, 1 = full scale) sits on the meter. Over full scale stays at the top. */
  meterPosition(level) {
    return AddOnLogic.meterPos(AddOnLogic.levelDb(level));
  },

  /** A dB value for a readout: one decimal, a sign above zero, −∞ for silence. */
  formatDb(db) {
    if (db === -Infinity || db < -143) return '−∞';
    const r = Math.round(db * 10) / 10;
    return `${r > 0 ? '+' : ''}${r.toFixed(1)}`.replace('-', '−');
  },

  /**
   * The meter's colours as one continuous CSS gradient, bottom to top on the audio scale: green
   * fading to yellow-green by −18 dBFS, yellow at −9, orange at −3 and red at 0 dBFS.
   */
  meterGradient() {
    const at = (db) => `${(AddOnLogic.meterPos(db) * 100).toFixed(2)}%`;
    return `linear-gradient(to top, #1f9d4c 0%, #3cbf4f ${at(-36)}, #9ccf3a ${at(-18)}, #e9d53a ${at(-9)}, #f39a2b ${at(-3)}, #ec4a2f 99%, #d9263a 100%)`;
  },

  // ---- EQ curve ------------------------------------------------------------------------------

  /** Plugin categories and names that mean an equaliser. */
  EQ_RE: /\beq\b|equali[sz]|pultec|\bqi\b|filter|luna channel|channel strip|ssl.*channel|api 5[56]0|neve 10(73|81)|maag|precision eq|helios|harrison/i,

  /** A number from a parameter: its real value, else the first number in its display ("1.2 kHz" → 1200). */
  paramNumber(p) {
    const r = p.real.value;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
    const d = String(p.display.value ?? '');
    const m = d.match(/-?\d+(\.\d+)?/);
    if (!m) return undefined;
    return parseFloat(m[0]) * (/k\s*hz|khz|k$/i.test(d) ? 1000 : 1);
  },

  /**
   * Read EQ bands from a plugin's parameters by their ids and names: `eq_b2_freq`, `Band 2
   * Gain`, `lf_gain`, `hpf_freq`... Returns `[{ type, freq, gain, q }]` with type `bell`,
   * `lowshelf`, `highshelf`, `hpf` or `lpf`, only for bands with a frequency. Plugins whose
   * parameters say nothing this can read give `[]`.
   */
  eqBands(params) {
    const bands = new Map();
    const band = (key) => { if (!bands.has(key)) bands.set(key, {}); return bands.get(key); };
    for (const p of params) {
      const id = `${p.id} ${p.name.value ?? ''}`.toLowerCase().replace(/[-_]/g, ' ');
      if (/bypass|power|output|input|mix|auto|link|solo|listen|enable|\bon\b|\bin\b/.test(id) && !/type|shape/.test(id)) continue;
      let key;
      const num = id.match(/(?:\bb|band|bnd|eq b)\s*(\d+)/);
      if (num) key = `b${num[1]}`;
      else if (/\b(hpf|hp|high ?pass|lo(w)? ?cut)\b/.test(id)) key = 'hpf';
      else if (/\b(lpf|lp|low ?pass|hi(gh)? ?cut)\b/.test(id)) key = 'lpf';
      else if (/\b(lf|low|lo|bass)\b/.test(id)) key = 'lf';
      else if (/\b(lmf|lo ?mid|low ?mid)\b/.test(id)) key = 'lmf';
      else if (/\b(hmf|hi ?mid|high ?mid)\b/.test(id)) key = 'hmf';
      else if (/\b(mf|mid)\b/.test(id)) key = 'mf';
      else if (/\b(hf|high|hi|treble|air)\b/.test(id)) key = 'hf';
      else continue;
      const b = band(key);
      if (/freq|hz|\bf\b/.test(id)) b.freq = AddOnLogic.paramNumber(p);
      else if (/\bq\b|bandwidth|\bbw\b|width|reso/.test(id)) b.q = AddOnLogic.paramNumber(p);
      else if (/type|shape|mode/.test(id)) b.shape = String(p.display.value ?? p.real.value ?? '').toLowerCase();
      else if (/gain|boost|cut|level|atten/.test(id)) {
        const sign = /atten|\bcut\b/.test(id) && !/lo ?cut|hi ?cut/.test(id) ? -1 : 1;
        b.gain = (b.gain ?? 0) + (AddOnLogic.paramNumber(p) ?? 0) * sign;
      }
      else if (!b.freq && /\d/.test(String(p.display.value ?? '')) && /hz/i.test(String(p.display.value))) b.freq = AddOnLogic.paramNumber(p);
    }
    const out = [];
    const keys = [...bands.keys()];
    const numbered = keys.filter((k) => /^b\d+$/.test(k)).sort((a, b) => +a.slice(1) - +b.slice(1));
    for (const [key, b] of bands) {
      if (!(b.freq > 10 && b.freq < 30000)) continue;
      let type = 'bell';
      if (key === 'hpf') type = 'hpf';
      else if (key === 'lpf') type = 'lpf';
      else if (/high ?pass|hpf|low ?cut/.test(b.shape ?? '')) type = 'hpf';
      else if (/low ?pass|lpf|high ?cut/.test(b.shape ?? '')) type = 'lpf';
      else if (/shelf/.test(b.shape ?? '')) type = /hi|high/.test(b.shape) ? 'highshelf' : /lo|low/.test(b.shape) ? 'lowshelf' : (b.freq < 1000 ? 'lowshelf' : 'highshelf');
      else if (b.q === undefined && (key === 'lf' || key === numbered[0])) type = 'lowshelf';
      else if (b.q === undefined && (key === 'hf' || key === numbered.at(-1))) type = 'highshelf';
      const band = { type, freq: b.freq, gain: b.gain ?? 0, q: b.q > 0.05 && b.q < 40 ? b.q : 0.7 };
      out.push(band);
    }
    return out;
  },

  /** The parameters eqBands reads (band frequency, gain, Q and shape), to follow for redraws. */
  eqParams(params) {
    return params.filter((p) => {
      const id = `${p.id} ${p.name.value ?? ''}`.toLowerCase().replace(/[-_]/g, ' ');
      return /(\bb|band|bnd|eq b)\s*\d|\b(hpf|lpf|hp|lp|lf|lmf|hmf|mf|hf|low|high|mid|bass|treble)\b/.test(id) && /freq|hz|gain|boost|cut|level|atten|\bq\b|bandwidth|\bbw\b|width|reso|type|shape|mode/.test(id);
    });
  },

  /** Magnitude in dB of one band at frequency f (RBJ cookbook biquads at 48 kHz). */
  bandDb(b, f, fs = 48000) {
    const A = 10 ** (b.gain / 40);
    const w0 = (2 * Math.PI * Math.min(b.freq, fs / 2.1)) / fs;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const alpha = sin / (2 * b.q);
    let b0, b1, b2, a0, a1, a2;
    if (b.type === 'bell') { b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; }
    else if (b.type === 'lowshelf' || b.type === 'highshelf') {
      const s = 2 * Math.sqrt(A) * (sin / (2 * 0.707));
      const sg = b.type === 'lowshelf' ? 1 : -1;
      b0 = A * ((A + 1) - sg * (A - 1) * cos + s); b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * cos); b2 = A * ((A + 1) - sg * (A - 1) * cos - s);
      a0 = (A + 1) + sg * (A - 1) * cos + s; a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * cos); a2 = (A + 1) + sg * (A - 1) * cos - s;
    } else if (b.type === 'hpf') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
    else { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
    const w = (2 * Math.PI * f) / fs;
    const re = (c0, c1, c2) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
    const im = (c1, c2) => -(c1 * Math.sin(w) + c2 * Math.sin(2 * w));
    const num = Math.hypot(re(b0, b1, b2), im(b1, b2));
    const den = Math.hypot(re(a0, a1, a2), im(a1, a2));
    return 20 * Math.log10(num / den);
  },

  /** The summed response in dB of every band at each frequency in `freqs`. */
  eqResponse(bands, freqs) {
    return freqs.map((f) => bands.reduce((sum, b) => sum + AddOnLogic.bandDb(b, f), 0));
  },

  /** Position (0..1, left to right) of a frequency on the EQ view's 20 Hz–20 kHz log axis. */
  eqX(f) { return Math.log10(Math.max(20, Math.min(20000, f)) / 20) / 3; },
  /** Position (0..1, top to bottom) of a gain on a ±`range` dB view. */
  eqY(db, range) { return 0.5 - (Math.max(-range, Math.min(range, db)) / range) * 0.46; },

  /** `n` frequencies spaced evenly on a log scale from 20 Hz to 20 kHz. */
  logFreqs(n) {
    return Array.from({ length: n }, (_, i) => 20 * 1000 ** (i / (n - 1)));
  },

  // ---- The selected channel opens wide ----------------------------------------------------

  /**
   * The id of the channel to show wide, among `shown`: LUNA's focused track when it is
   * selected, else the first selected one shown. `collapsedId` is a channel the user closed
   * here; it stays narrow until the selection moves. Null when nothing qualifies.
   */
  expandedId(session, shown, collapsedId = null) {
    const ids = new Set(shown.map((ch) => ch.id));
    const sel = (session.context.selectionTracks.value ?? []).filter((id) => ids.has(id));
    if (sel.length === 0) return null;
    const focus = session.context.lastSelectedTrack.value;
    const id = focus && sel.includes(focus) ? focus : sel[0];
    return id === collapsedId ? null : id;
  },

  /**
   * The insert slots that hold a plugin, in slot order, with a display name. The slot's own
   * plugin_name can stay null for a loaded plugin (fact 86), so `nameOf(pluginId)` (the
   * catalog) is asked first.
   */
  inserts(ch, nameOf = () => undefined) {
    // The console slot (LUNA Channel, API Vision…), the summing input and tape come first, as
    // LUNA's mixer shows them apart from the effect inserts; then effect_0, effect_1…
    const rank = (id) => (id === 'console' ? 0 : id === 'bus_input' ? 1 : id === 'tape' ? 2 : 10 + Number(id.split('_')[1] ?? 0));
    return ch.effects.items
      .filter((slot) => !slot.isEmpty && AddOnLogic.SHOWN_SLOT_RE.test(slot.id))
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map((slot) => ({
        slot,
        name: AddOnLogic.slotName(slot, nameOf),
        error: slot.pluginError.value ?? slot.pluginLicenseError?.value ?? null,
        place: /^effect_/.test(slot.id) ? null : slot.id === 'bus_input' ? 'summing' : slot.id,
      }))
      // LUNA Channel, API Vision… in the console slot can show up again as an insert: keep the console one.
      .filter((row, _, rows) => row.place || !rows.some((r) => r.place === 'console' && AddOnLogic.sameName(r.name, row.name)));
  },

  /** A slot's plugin name: the catalog's, else the slot's own, else its id. */
  slotName(slot, nameOf = () => undefined) {
    return nameOf(slot.pluginId.value) ?? slot.pluginName.value ?? slot.pluginId.value ?? '…';
  },

  /** Two plugin names that mean the same plugin (case and spacing aside). */
  sameName(a, b) {
    const n = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return n(a) !== '' && n(a) === n(b);
  },

  /**
   * One slot per plugin name, for the EQ view: where the console slot and an insert hold the same
   * plugin, keep the one whose bands can be read (the console one when both can).
   */
  dedupeSlots(slots, nameOf = () => undefined) {
    const out = [];
    const rank = (sl) => (AddOnLogic.eqBands(sl.params).length > 0 ? 0 : 2) + (sl.id === 'console' ? 0 : 1);
    for (const sl of [...slots].sort((a, b) => rank(a) - rank(b))) {
      if (!out.some((o) => AddOnLogic.sameName(AddOnLogic.slotName(o, nameOf), AddOnLogic.slotName(sl, nameOf)))) out.push(sl);
    }
    return slots.filter((sl) => out.includes(sl));
  },

  /** Insert slots the wide strip lists: effect inserts, the console slot and the summing input. */
  SHOWN_SLOT_RE: /^(effect_\d+|console|bus_input)$/,   // not tape: LUNA opens only a generic parameter page for it

  /** The sends that go somewhere, in slot order, with the destination's name. */
  sends(ch) {
    return ch.outputs.items
      .filter((o) => o.isSend && (o.destinations.value ?? []).length > 0)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((send) => ({
        send,
        to: (send.destinations.value ?? []).map((d) => (d.error ? `${d.name} (!)` : d.name)).join(' + '),
      }));
  },

  /**
   * A string that changes when what the wide strip lists changes (plugins loaded or removed,
   * sends routed or cleared), so the page rebuilds it only then.
   */
  wideKey(ch) {
    const slots = ch.effects.items.map((s) => `${s.id}=${s.pluginId.value ?? ''}:${s.pluginError.value ?? ''}`).join(',');
    const sends = ch.outputs.items.filter((o) => o.isSend).map((o) => `${o.id}>${(o.destinations.value ?? []).map((d) => d.uid).join('+')}`).join(',');
    return `${slots}|${sends}`;
  },

  /** Select a track in LUNA, as clicking its name in LUNA's own mixer does. */
  async select(session, ch) {
    await session.context.selectionTracks.set([ch.id]);
    await session.context.lastSelectedTrack.set(ch.id);
  },
};

globalThis.AddOnLogic = AddOnLogic;

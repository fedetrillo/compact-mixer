// Compact Mixer: DOM wiring. Connects to LUNA, follows the focused session and draws a strip per
// channel that passes the filter. Narrow strips are a fader-meter lane with mute and solo; the
// selected channel and any pinned ones open wide with inserts, sends, an EQ curve and pan.
// Faders, pans and sends go through Luna.bindDrag / Luna.bindRange (one undo step per drag),
// meters move by transform only, and every listener is held in a Luna.Bindings that is released
// on rebuild.

(() => {
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const say = (text, err = false) => { status.textContent = text; status.classList.toggle('error', err); };
  const report = (e) => say(String(e?.message || e), true);

  // ---- Remembered view state (per viewer, namespaced by the Add On id) -----------------------
  const STORE_KEY = 'com.fedetrillo.compact_mixer.view';
  const loadView = () => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && Array.isArray(v.kinds)) return { filter: { ...AddOnLogic.emptyFilter(), ...v.filter, kinds: v.kinds }, tiny: !!v.tiny };
    } catch { /* storage unavailable or corrupt: start fresh */ }
    return { filter: AddOnLogic.emptyFilter(), tiny: false };
  };
  const view = loadView();
  const saveView = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ filter: { query: view.filter.query, color: view.filter.color }, kinds: view.filter.kinds, tiny: view.tiny })); }
    catch { /* not fatal */ }
  };
  // Pinned (always wide) channels, per session.
  const pinKey = (s) => `${STORE_KEY}.pins.${s.uid}`;
  const loadPins = (s) => { try { return new Set(JSON.parse(localStorage.getItem(pinKey(s)) || '[]')); } catch { return new Set(); } };
  const savePins = (s, pins) => { try { localStorage.setItem(pinKey(s), JSON.stringify([...pins])); } catch { /* not fatal */ } };

  // ---- Toolbar -------------------------------------------------------------------------------
  const KIND_LABELS = { audio: 'Audio', instrument: 'Inst', bus: 'Bus', cue: 'Cue' };
  const kindsBox = $('kinds');
  for (const k of AddOnLogic.KINDS) {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.kind = k; b.textContent = KIND_LABELS[k];
    b.onclick = (e) => {
      const f = view.filter;
      if (e.altKey) f.kinds = [k];                                   // Option-click: only this kind
      else f.kinds = f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k];
      filterChanged();
    };
    kindsBox.append(b);
  }
  const search = $('search');
  search.value = view.filter.query;
  search.addEventListener('input', () => { view.filter.query = search.value; filterChanged(); });
  // Keys typed in the search box belong to the page, not to LUNA's shortcuts.
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { search.value = ''; view.filter.query = ''; filterChanged(); search.blur(); }
  });
  $('reset').onclick = () => { view.filter = AddOnLogic.emptyFilter(); search.value = ''; filterChanged(); };
  const applyDensity = () => {
    document.body.classList.toggle('tiny', view.tiny);
    $('density').title = view.tiny ? 'Strip width: narrower (click for narrow)' : 'Strip width: narrow (click for narrower)';
    $('density').classList.toggle('on', view.tiny);
  };
  $('density').onclick = () => { view.tiny = !view.tiny; applyDensity(); saveView(); };
  applyDensity();

  const renderToolbar = () => {
    for (const b of kindsBox.children) b.classList.toggle('on', view.filter.kinds.includes(b.dataset.kind));
    $('reset').disabled = AddOnLogic.isEmptyFilter(view.filter);
  };

  // ---- Connection and session ----------------------------------------------------------------
  let luna;
  let session;
  let built;
  let page = new Luna.Bindings();     // session-level listeners
  let meta = new Luna.Bindings();     // name/colour/mute/solo of every channel (for filter + counts)
  let strips = new Luna.Bindings();   // listeners and bindings of the strips on screen
  let filterChanged = () => { renderToolbar(); saveView(); };
  let collapsedId = null;             // a selected channel the user closed here
  let pins = new Set();               // channels kept wide
  let onNameClick = () => {};
  let onPinClick = () => {};
  let onMove = async () => {};
  let canMove = () => false;
  let flashId = null;                 // the channel just moved, to scroll to and flash
  const plugin = (id) => (id ? luna.plugins.byId(id) : undefined);
  const pluginName = (id) => plugin(id)?.name.value;

  /** Every slot holding a plugin, including the console and tape slots (LUNA Channel lives there). */
  const loadedSlots = (ch) => ch.effects.items.filter((sl) => !sl.isEmpty && !/^record_fx|sidechain/.test(sl.id));

  /** Load what a wide strip shows: sends and their controls, and every loaded plugin's parameters. */
  async function loadWide(ch) {
    await Promise.all([ch.effects.load(), ch.outputs.load()]).catch(() => undefined);
    await Promise.all([
      ...ch.outputs.items.filter((o) => o.isSend).map((o) => o.controls.load().catch(() => undefined)),
      ...loadedSlots(ch).map((sl) => sl.controls.load().catch(() => undefined)),
    ]);
  }

  /**
   * What, when it changes, means the wide strips must be rebuilt: plugins in/out, sends routed.
   * Narrow strips show no plugins, so they are not watched: a session-wide change (the console
   * type swapped on every channel) rebuilds only the wide strips, and only once it settles.
   */
  const structureKey = (wides) => wides.map((ch) => {
    const slots = ch.effects.items.map((sl) => `${sl.pluginId.value ?? ''}:${sl.in.value === false ? 0 : 1}`).join(',');
    return `${ch.id}[${slots}]${AddOnLogic.wideKey(ch)}`;
  }).join(';');
  const STRUCTURE_SETTLE_MS = 500;

  async function build() {
    const s = luna.sessions.current();
    if (s && s === built) return;
    built = s;
    session = s;
    page.dispose(); meta.dispose(); strips.dispose(); eqLarge?.close();
    page = new Luna.Bindings(); meta = new Luna.Bindings();
    const group = strips = new Luna.Bindings();
    $('strips').replaceChildren(); $('masterBox').replaceChildren();
    if (!s) { say('no session open in LUNA'); return; }
    await s.ready();
    if (s !== built) return;
    pins = loadPins(s);
    collapsedId = null;
    say(s.name.value ?? '');
    page.on(s.name, () => say(s.name.value ?? ''));

    bindTransport(s);

    $('clearSolo').onclick = () => AddOnLogic.clearSolos(s).catch(report);
    $('unmute').onclick = () => AddOnLogic.unmuteAll(s).catch(report);

    const renderCounts = () => {
      const { soloed, muted } = AddOnLogic.counts(s);
      const cs = $('clearSolo'); cs.textContent = `S ${soloed}`; cs.classList.toggle('active', soloed > 0); cs.disabled = soloed === 0;
      const um = $('unmute'); um.textContent = `M ${muted}`; um.classList.toggle('active', muted > 0); um.disabled = muted === 0;
    };

    const renderColors = () => {
      const box = $('colors');
      const colors = AddOnLogic.colors(s, view.filter.kinds);
      if (view.filter.color && !colors.includes(view.filter.color)) view.filter.color = null;
      box.replaceChildren(...colors.map((c) => {
        const d = document.createElement('button');
        d.className = 'dot'; d.style.background = c; d.title = 'Only this colour';
        d.classList.toggle('on', view.filter.color === c);
        d.onclick = () => { view.filter.color = view.filter.color === c ? null : c; filterChanged(); };
        return d;
      }));
    };

    const renderSelection = () => {
      const sel = new Set(s.context.selectionTracks.value ?? []);
      for (const el of document.querySelectorAll('.strip')) el.classList.toggle('selected', sel.has(el.dataset.id));
    };

    // Which strips are wide: the selected one (unless closed here) and the pinned ones.
    let selectedWide = null;
    let renderedKey = '';
    const selectionChanged = () => {
      const next = AddOnLogic.expandedId(s, AddOnLogic.filtered(s, view.filter), collapsedId);
      if (next !== selectedWide) void group.whenIdle(render);
      else renderSelection();
    };
    page.on(s.context.selectionTracks, () => { collapsedId = null; selectionChanged(); });
    page.on(s.context.lastSelectedTrack, selectionChanged);

    // Name click: select in LUNA (opens wide), or close/reopen the selected one here.
    onNameClick = (ch) => {
      if (pins.has(ch.id)) { AddOnLogic.select(s, ch).catch(report); return; }
      const selected = (s.context.selectionTracks.value ?? []).includes(ch.id);
      if (!selected) { collapsedId = null; AddOnLogic.select(s, ch).catch(report); return; }
      collapsedId = selectedWide === ch.id ? ch.id : null;
      if (collapsedId === null && s.context.lastSelectedTrack.value !== ch.id) AddOnLogic.select(s, ch).catch(report);
      void group.whenIdle(render);
    };
    // A click on empty space in the mixer clears the selection, as in LUNA's mixer, so the
    // selected channel goes back to narrow.
    const onEmptyClick = (e) => {
      if (e.target !== e.currentTarget && e.target.id !== 'empty') return;
      if ((s.context.selectionTracks.value ?? []).length === 0) { if (selectedWide) { collapsedId = selectedWide; void group.whenIdle(render); } return; }
      s.context.selectionTracks.set([]).catch(report);
    };
    for (const id of ['strips', 'body', 'masterBox']) {
      const el = $(id);
      el.addEventListener('click', onEmptyClick);
      page.add(() => el.removeEventListener('click', onEmptyClick));
    }

    // Pin: keep a channel wide whatever is selected (a drum bus wide, its tracks narrow).
    onPinClick = (ch) => {
      if (pins.has(ch.id)) pins.delete(ch.id); else pins.add(ch.id);
      savePins(s, pins);
      void group.whenIdle(render);
    };

    // Strips: rebuilt through whenIdle, so never mid-drag.
    const render = async () => {
      const list = AddOnLogic.filtered(s, view.filter);
      await Promise.all(list.map((ch) => Promise.all([ch.loadStrip(), ch.controls.load()]).catch(() => undefined)));
      const selId = AddOnLogic.expandedId(s, list, collapsedId);
      const wideSet = new Set(list.filter((ch) => ch.id === selId || pins.has(ch.id)).map((ch) => ch.id));
      await Promise.all(list.filter((ch) => wideSet.has(ch.id)).map(loadWide));
      if (s !== built) return;
      if (group.busy) { void group.whenIdle(render); return; }
      group.clear();
      selectedWide = selId;
      const wides = list.filter((ch) => wideSet.has(ch.id));
      renderedKey = structureKey(wides);
      // Rebuild the wide strips when a plugin is loaded, removed or bypassed, or a send routed:
      // once the changes have stopped for a moment, not at every step of a swap.
      let settleTimer = 0;
      const recheck = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => { if (structureKey(wides) !== renderedKey) void group.whenIdle(render); }, STRUCTURE_SETTLE_MS);
      };
      group.add(() => clearTimeout(settleTimer));
      for (const ch of wides) {
        for (const sl of ch.effects.items) { group.on(sl.pluginId, recheck); group.on(sl.in, recheck); }
        for (const o of ch.outputs.items.filter((o) => o.isSend)) group.on(o.destinations, recheck);
      }
      const master = list.filter((ch) => AddOnLogic.kindOf(ch) === 'master');
      const rest = list.filter((ch) => AddOnLogic.kindOf(ch) !== 'master');
      const total = AddOnLogic.channels(s).filter((ch) => !['master', 'other'].includes(AddOnLogic.kindOf(ch))).length;
      $('count').textContent = `${rest.length} / ${total}`;
      const make = (ch) => strip(s, ch, group, wideSet.has(ch.id), pins.has(ch.id));
      if (rest.length) $('strips').replaceChildren(...rest.map(make));
      else {
        const e = document.createElement('div'); e.id = 'empty'; e.textContent = 'No channel matches the filter.';
        $('strips').replaceChildren(e);
      }
      $('masterBox').replaceChildren(...master.map(make));
      for (const el of document.querySelectorAll('.strip')) el.attach?.();
      renderRuler();
      renderSelection();
      const focusId = flashId ?? selId;
      const focusEl = document.querySelector(`.strip[data-id="${CSS.escape(focusId ?? '')}"]`);
      focusEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (flashId && focusEl) focusEl.classList.add('moved');
      flashId = null;
    };

    // Everything the filter, colours and counts depend on, for every channel (not just shown ones).
    const watchAll = async () => {
      meta.clear();
      const all = AddOnLogic.channels(s);
      await Promise.all(all.map((ch) => Promise.all([ch.loadStrip(), ch.controls.load()]).catch(() => undefined)));
      if (s !== built) return;
      for (const ch of all) {
        meta.on(ch.name, () => { if (view.filter.query.trim()) void group.whenIdle(render); });
        meta.on(ch.color, () => { renderColors(); if (view.filter.color) void group.whenIdle(render); });
        meta.on(ch.order, orderChanged);         // moved here or in LUNA
        meta.on(ch.folderUid, orderChanged);
        const solo = AddOnLogic.soloOf(ch); const mute = AddOnLogic.muteOf(ch);
        if (solo) meta.on(solo.real, renderCounts);
        if (mute) meta.on(mute.real, renderCounts);
      }
      renderColors(); renderCounts();
    };

    // A move changes several channels' order at once: rebuild once, a moment later.
    let orderTimer;
    const orderChanged = () => { clearTimeout(orderTimer); orderTimer = setTimeout(() => void group.whenIdle(render), 40); };
    page.add(() => clearTimeout(orderTimer));

    // Move a channel one step left or right in LUNA, among the channels this view shows.
    onMove = async (ch, dir) => {
      const shown = new Set(AddOnLogic.filtered(s, view.filter).map((c) => c.id));
      try {
        const moved = await AddOnLogic.move(s, ch, dir, shown);
        if (!moved) return;
        flashId = ch.id;
      } catch (e) { report(e); }
    };
    canMove = (ch, dir) => !!AddOnLogic.moveTarget(s, ch, dir, new Set(AddOnLogic.filtered(s, view.filter).map((c) => c.id)));
    // Option + ←/→ moves the channel selected in LUNA.
    const onKey = (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const id = s.context.lastSelectedTrack.value ?? (s.context.selectionTracks.value ?? [])[0];
      const ch = id && AddOnLogic.channels(s).find((c) => c.id === id);
      if (!ch || !AddOnLogic.movable(ch)) return;
      e.preventDefault(); e.stopPropagation();
      void onMove(ch, e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey, true);
    page.add(() => window.removeEventListener('keydown', onKey, true));

    let resizeTimer;
    page.add(((fn) => { window.addEventListener('resize', fn); return () => window.removeEventListener('resize', fn); })(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void group.whenIdle(render), 250);
    }));

    filterChanged = () => { renderToolbar(); renderColors(); saveView(); void group.whenIdle(render); };
    const channelsChanged = async () => { await watchAll(); await group.whenIdle(render); };
    page.on(s.tracks, () => void channelsChanged());
    page.on(s.buses, () => void channelsChanged());
    renderToolbar();
    await channelsChanged();
  }

  // ---- One strip -----------------------------------------------------------------------------
  const PIN_SVG = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M4 1h4l-.6 3.2L9.5 6.5v1h-3V11L6 11.6 5.5 11V7.5h-3v-1l2.1-2.3z" fill="currentColor"/></svg>';

  function strip(s, ch, bindings, wide = false, pinned = false) {
    const info = AddOnLogic.info(ch);
    const el = document.createElement('div');
    el.className = `strip ${info.kind}${wide ? ' wide' : ''}${pinned ? ' pinned' : ''}`;
    el.dataset.id = ch.id;
    const faderCol = `
      <div class="peak"></div>
      <div class="lane"><div class="bars"></div><div class="ticks"></div><div class="hline"></div><div class="cap"></div></div>
      <div class="db"></div>
      <div class="buttons"></div>`;
    el.innerHTML = wide ? `
      <div class="color"></div>
      <div class="head"><div class="name"></div></div>
      <div class="cols">
        <div class="side">
          <div class="sec"><div class="h">Inserts</div><div class="inserts"></div></div>
          <div class="sec eqsec"><div class="h">EQ <span class="eqname"></span></div><div class="eq"></div></div>
          <div class="sec"><div class="h">Sends</div><div class="sends"></div></div>
          <div class="sec pansec"><div class="h">Pan <span class="panlabel"></span></div><div class="pans"></div></div>
        </div>
        <div class="fadercol">${faderCol}</div>
      </div>` : `
      <div class="color"></div>
      <div class="head"><div class="name"></div></div>
      ${faderCol}`;

    const colorBar = el.querySelector('.color');
    const renderColor = () => { colorBar.style.background = AddOnLogic.cssColor(ch.color.value) ?? (info.kind === 'master' ? 'var(--accent)' : '#555'); };
    renderColor();
    bindings.on(ch.color, renderColor);

    const name = el.querySelector('.name');
    const renderName = () => { const n = ch.name.value ?? ch.id; name.textContent = n; name.title = `${n} (${info.kind})`; };
    renderName();
    bindings.on(ch.name, renderName);
    if (info.kind !== 'master') {
      name.onclick = () => onNameClick(ch);
      name.title += wide && !pinned ? ' — click to narrow' : ' — click to select';
      const pin = document.createElement('button');
      pin.className = `pin${pinned ? ' on' : ''}`;
      pin.innerHTML = PIN_SVG;
      pin.title = pinned ? 'Unpin: back to narrow' : 'Pin wide: keep this channel wide';
      pin.onclick = (e) => { e.stopPropagation(); onPinClick(ch); };
      const head = el.querySelector('.head');
      if (wide && AddOnLogic.movable(ch)) {
        const mk = (dir, label, title) => {
          const b = document.createElement('button');
          b.className = 'mv'; b.textContent = label; b.title = title;
          b.disabled = !canMove(ch, dir);
          b.onclick = (e) => { e.stopPropagation(); void onMove(ch, dir); };
          return b;
        };
        head.prepend(mk(-1, '◀', 'Move left in LUNA (Option+←)'));
        head.append(mk(1, '▶', 'Move right in LUNA (Option+→)'));
      }
      head.append(pin);
    }
    if (wide) { fillWide(ch, el, bindings); widePan(ch, el, bindings); }

    // ---- Fader lane = meter --------------------------------------------------------------
    // The whole lane shows the level; the fader is only the thin cap line. Both use the gain
    // fader's taper, so the bar reaches the cap's dB mark when the level is at that many dBFS.
    const lane = el.querySelector('.lane');
    const bars = lane.querySelector('.bars');
    const cap = lane.querySelector('.cap');
    const ticks = lane.querySelector('.ticks');
    const taper = AddOnLogic.taperOf(ch);          // the fader line's scale
    const gradient = AddOnLogic.meterGradient();    // the meter's: audio dBFS, 0 at the top
    const n = Math.max(1, ch.meter.numStreams.value ?? 1);
    const streams = Array.from({ length: n }, () => {
      const st = document.createElement('div'); st.className = 'stream'; st.innerHTML = '<i><u></u></i><b></b>';
      st.firstChild.firstChild.style.background = gradient;
      bars.append(st); return st;
    });

    // Audio-scale marks (dBFS), as on LUNA's meters; numbers only on the master, where there is room.
    for (const mark of AddOnLogic.METER_MARKS) {
      const t = document.createElement('div');
      t.className = `tick${mark === 0 ? ' zero' : ''}`;
      t.style.bottom = `${(AddOnLogic.meterPos(mark) * 100).toFixed(2)}%`;
      if (info.kind === 'master' && mark !== 0) { const l = document.createElement('span'); l.textContent = String(-mark); t.append(l); }
      ticks.append(t);
    }

    // Hover: a line across the lane and its dB on the ruler, to read where a level sits.
    const hline = lane.querySelector('.hline');
    lane.addEventListener('pointermove', (e) => {
      const r = lane.getBoundingClientRect();
      const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      hline.style.top = `${(y * 100).toFixed(2)}%`;
      if (!lane.classList.contains('dragging')) showRulerHover(1 - y);
    });
    lane.addEventListener('pointerleave', () => showRulerHover(null));

    // The cap: a full-lane layer whose top edge is the line, moved by transform only.
    const placeCap = (v) => { cap.style.transform = `translateY(${((1 - Math.min(1, Math.max(0, v))) * 100).toFixed(2)}%)`; };
    placeCap(ch.gain.normalized.value ?? 0);
    const db = el.querySelector('.db');
    const renderDb = () => { db.textContent = ch.gain.display.value ?? ''; };
    renderDb();
    bindings.on(ch.gain.display, renderDb);

    // Dragging anywhere on the lane moves the cap by the same distance (no jump on click), as
    // one undo step; double-click resets to LUNA's default, arrows nudge. pixelsPerUnit is the
    // lane's height, known once the strip is on screen: attach() runs after it is inserted.
    const attach = () => {
      Luna.bindDrag(lane, ch.gain, {
        bindings, label: `${ch.name.value ?? ch.id} volume`, axis: 'y',
        pixelsPerUnit: Math.max(60, lane.clientHeight), step: 0.005, render: placeCap,
        onBegin: () => lane.classList.add('dragging'), onEnd: () => lane.classList.remove('dragging'), onError: report,
      });
    };

    // Levels, held-peak lines (1.5 s), clip outline, and a numeric peak readout that holds the
    // highest level until clicked.
    const peakEl = el.querySelector('.peak');
    const held = streams.map(() => ({ value: 0, at: 0 }));
    const HOLD_MS = 1500;
    let maxLevel = 0;
    const renderPeakText = () => {
      const d = AddOnLogic.levelDb(maxLevel);
      peakEl.textContent = maxLevel > 0 ? AddOnLogic.formatDb(d) : '';
      peakEl.classList.toggle('hot', d > -0.05);
    };
    peakEl.title = 'Highest level since the last click (dBFS). Click to reset.';
    peakEl.onclick = () => { maxLevel = 0; renderPeakText(); lane.classList.remove('clip'); };
    const off = (pos) => `${((1 - pos) * 100).toFixed(2)}%`;
    bindings.add(ch.meter.onChange(() => {
      const levels = ch.meter.level.value ?? [];
      const now = performance.now();
      let loudest = 0;
      streams.forEach((st, i) => {
        const level = levels[i] ?? 0;
        if (level > loudest) loudest = level;
        const pos = AddOnLogic.meterPosition(level);
        st.firstChild.style.transform = `translateY(${off(pos)})`;
        st.firstChild.firstChild.style.transform = `translateY(-${off(pos)})`;
        const h = held[i];
        if (pos >= h.value || now - h.at > HOLD_MS) { h.value = pos; h.at = now; st.lastChild.style.transform = `translateY(${off(pos)})`; }
      });
      if (loudest > maxLevel) { maxLevel = loudest; renderPeakText(); }
    }));
    bindings.on(ch.meter.clip, () => { if ((ch.meter.clip.value ?? []).some(Boolean)) lane.classList.add('clip'); });


    // Mute and solo: one click, one undo step.
    const buttons = el.querySelector('.buttons');
    const mute = AddOnLogic.muteOf(ch);
    const solo = AddOnLogic.soloOf(ch);
    if (mute) {
      const b = document.createElement('button'); b.className = 'mute'; b.textContent = 'M'; b.title = 'Mute';
      const r = () => b.classList.toggle('on', mute.on); r(); bindings.on(mute.real, r);
      b.onclick = () => mute.toggle().catch(report);
      buttons.append(b);
    }
    if (solo) {
      const b = document.createElement('button'); b.className = 'solo'; b.textContent = 'S'; b.title = 'Solo';
      const r = () => b.classList.toggle('on', solo.on); r(); bindings.on(solo.real, r);
      b.onclick = () => solo.toggle().catch(report);
      buttons.append(b);
    }
    el.attach = attach;
    return el;
  }

  // ---- Wide strip: inserts, EQ, sends, pan -------------------------------------------------------
  function fillWide(ch, el, bindings) {
    const insBox = el.querySelector('.inserts');
    const rows = AddOnLogic.inserts(ch, pluginName);
    if (rows.length === 0) insBox.innerHTML = '<div class="none">No inserts</div>';
    for (const { slot, name, error, place } of rows) {
      const row = document.createElement('div');
      row.className = `ins${place ? ` place-${place}` : ''}`;
      // Power: IN/OUT through setIn, which drives the plugin's own bypass control (fact 29).
      const pwr = document.createElement('button');
      pwr.className = 'pwr'; pwr.title = 'In / bypass';
      const renderIn = () => { pwr.classList.toggle('on', slot.in.value !== false); row.classList.toggle('bypassed', slot.in.value === false); };
      renderIn(); bindings.on(slot.in, renderIn);
      pwr.onclick = () => slot.setIn(slot.in.value === false).catch(report);
      // Name: opens and closes the plugin's window in LUNA; lit while it is open.
      const nm = document.createElement('button');
      nm.className = 'pname';
      nm.innerHTML = '<span class="pt"></span><span class="open-ic">↗</span>';
      nm.firstChild.textContent = name;
      if (place) { const tag = document.createElement('span'); tag.className = 'place'; tag.textContent = place; nm.prepend(tag); }
      nm.title = error ? `${name}: ${error}` : `Open ${name} (click again to close)`;
      if (error) nm.classList.add('err');
      const renderOpen = () => nm.classList.toggle('open', slot.editorOpen.value === true);
      renderOpen(); bindings.on(slot.editorOpen, renderOpen);
      nm.onclick = () => {
        const opening = slot.editorOpen.value !== true;
        (opening ? slot.openEditor() : slot.closeEditor()).catch((e) => report(`${name} (${slot.id}): ${opening ? 'could not open' : 'could not close'} — ${e?.code ?? ''} ${e?.message ?? e}`));
      };
      row.append(pwr, nm);
      insBox.append(row);
    }

    drawEq(ch, el, bindings);

    const sendBox = el.querySelector('.sends');
    const sends = AddOnLogic.sends(ch);
    if (sends.length === 0) sendBox.innerHTML = '<div class="none">No sends</div>';
    for (const { send, to } of sends) {
      const row = document.createElement('div');
      row.className = 'send';
      row.innerHTML = '<div class="top"><span class="to"></span><span class="sdb"></span></div><div class="bot"><input type="range" min="0" max="1000" step="1"><button class="smute" title="Mute send">M</button><button class="spre" title="Pre-fader">P</button></div>';
      row.querySelector('.to').textContent = to;
      row.querySelector('.to').title = to;
      const range = row.querySelector('input');
      Luna.bindRange(range, send.gain, { bindings, onError: report });   // drag = one undo step; double-click resets
      const sdb = row.querySelector('.sdb');
      const renderDb = () => { sdb.textContent = send.gain.display.value ?? ''; };
      renderDb(); bindings.on(send.gain.display, renderDb);
      const m = row.querySelector('.smute');
      const renderM = () => { m.classList.toggle('on', send.mute.on); row.classList.toggle('muted', send.mute.on); };
      renderM(); bindings.on(send.mute.real, renderM);
      m.onclick = () => send.mute.toggle().catch(report);
      const pre = row.querySelector('.spre');
      const renderP = () => pre.classList.toggle('on', send.preFader.on);
      renderP(); bindings.on(send.preFader.real, renderP);
      pre.onclick = () => send.preFader.toggle().catch(report);
      sendBox.append(row);
    }
  }

  // Pan: only on wide strips. One slider for mono, two for stereo. Drag = one undo step,
  // double-click centres.
  function widePan(ch, el, bindings) {
    const pans = ch.main.pans ?? [];
    const panBox = el.querySelector('.pans');
    const panLabel = el.querySelector('.panlabel');
    if (pans.length === 0) { el.querySelector('.pansec').remove(); return; }
    const renderPan = () => { panLabel.textContent = pans.map((c) => c.display.value ?? '').join(' '); };
    for (const c of pans) {
      const r = document.createElement('input');
      r.type = 'range'; r.className = 'pan'; r.min = '0'; r.max = '1000'; r.step = '1';
      Luna.bindRange(r, c, { bindings, onError: report });
      bindings.on(c.display, renderPan);
      panBox.append(r);
    }
    renderPan();
  }

  // ---- EQ view: the curve, and points to drag that write the plugin's own parameters ----------
  const EQ_FREQS = AddOnLogic.logFreqs(120);

  /** The loaded plugins on `ch` that look like EQs or have band parameters we can read. */
  function eqSlotsOf(ch) {
    const found = loadedSlots(ch).filter((sl) => sl.id !== 'tape').filter((sl) => {
      const p = plugin(sl.pluginId.value);
      const text = [...(p?.categories ?? []), p?.name.value, sl.pluginName.value, sl.pluginId.value].filter(Boolean).join(' ');
      return AddOnLogic.EQ_RE.test(text) || AddOnLogic.eqBands(sl.params).length > 0;
    });
    return AddOnLogic.dedupeSlots(found, pluginName);
  }

  function drawEq(ch, el, bindings) {
    const box = el.querySelector('.eq');
    const label = el.querySelector('.eqname');
    const eqSlots = eqSlotsOf(ch);
    if (eqSlots.length === 0) { box.innerHTML = '<div class="none">No EQ</div>'; return; }
    const big = document.createElement('button');
    big.className = 'eqbig'; big.textContent = '⤢'; big.title = 'Open the EQ large';
    big.onclick = () => openEqLarge(ch);
    el.querySelector('.eqsec .h').append(big);
    eqView(box, ch, eqSlots, bindings, { range: 12, label });
  }

  /**
   * Draw the summed curve of `eqSlots` into `box`, read from the plugins' band parameters. Just
   * the curve: view only, it follows the plugin and does not write to it.
   */
  function eqView(box, ch, eqSlots, bindings, { range, label, readout }) {
    box.innerHTML = `<div class="eqarea"><svg preserveAspectRatio="none" viewBox="0 0 1000 1000"></svg></div><div class="eqnote"></div>`;
    const svg = box.querySelector('svg');
    const note = box.querySelector('.eqnote');
    const X = (f) => AddOnLogic.eqX(f) * 1000;
    const Y = (d) => AddOnLogic.eqY(d, range) * 1000;
    const gridDb = range > 12 ? [-12, -6, 6, 12] : [-6, 6];
    svg.innerHTML = [50, 100, 200, 500, 1000, 2000, 5000, 10000].map((f) => `<line x1="${X(f)}" x2="${X(f)}" y1="0" y2="1000" class="g${[100, 1000, 10000].includes(f) ? ' g2' : ''}"/>`).join('')
      + gridDb.map((d) => `<line x1="0" x2="1000" y1="${Y(d)}" y2="${Y(d)}" class="g"/>`).join('')
      + `<line x1="0" x2="1000" y1="${Y(0)}" y2="${Y(0)}" class="z"/><path class="fill"/><path class="curve"/>`;
    const fill = svg.querySelector('.fill');
    const curve = svg.querySelector('.curve');
    let queued = false;

    const redraw = () => {
      queued = false;
      const active = eqSlots.filter((sl) => sl.in.value !== false);
      const perSlot = active.map((sl) => ({ sl, bands: AddOnLogic.eqBands(sl.params) }));
      const rows = perSlot.flatMap(({ sl, bands }) => bands.map((b) => ({ b, sl })));
      const resp = AddOnLogic.eqResponse(rows.map((r) => r.b), EQ_FREQS);
      const pts = EQ_FREQS.map((f, i) => `${X(f).toFixed(1)},${Y(resp[i]).toFixed(1)}`);
      curve.setAttribute('d', `M${pts.join('L')}`);
      fill.setAttribute('d', `M0,${Y(0)}L${pts.join('L')}L1000,${Y(0)}Z`);
      box.classList.toggle('off', active.length === 0);
      if (label) label.textContent = active.map((sl) => pluginName(sl.pluginId.value) ?? sl.pluginName.value ?? '').filter(Boolean).join(' + ') || 'bypassed';
      const unreadable = perSlot.filter((x) => x.bands.length === 0).map((x) => x.sl);
      note.textContent = unreadable.length ? `Not readable: ${unreadable.map((sl) => pluginName(sl.pluginId.value) ?? sl.pluginName.value ?? sl.pluginId.value).join(', ')}` : '';
      if (readout) readout(rows);
    };
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(redraw); } };
    // Follow only the parameters the curve is drawn from (frequency, gain, Q, shape), not every
    // parameter of the plugin.
    for (const sl of eqSlots) {
      bindings.on(sl.in, schedule);
      for (const p of AddOnLogic.eqParams(sl.params)) bindings.on(p.real, schedule);
    }
    redraw();
  }

  const formatHz = (f) => (f >= 1000 ? `${(Math.round(f / 10) / 100).toString()} kHz` : `${Math.round(f)} Hz`);

  // The EQ, large, over the mixer. Esc or a click outside closes it.
  let eqLarge = null;
  function openEqLarge(ch) {
    eqLarge?.close();
    const eqSlots = eqSlotsOf(ch);
    const b = new Luna.Bindings();
    const ov = document.createElement('div');
    ov.className = 'eqoverlay';
    ov.innerHTML = `<div class="eqpanel"><div class="eqtop"><span class="t"></span><span class="eqname"></span><button class="x" title="Close (Esc)">✕</button></div><div class="eq large"></div><div class="bands"></div><div class="hint">View only: adjust the EQ in the plugin itself.</div></div>`;
    ov.querySelector('.t').textContent = ch.name.value ?? ch.id;
    const bandsEl = ov.querySelector('.bands');
    const readout = (rows) => {
      bandsEl.replaceChildren(...rows.map(({ b }) => {
        const d = document.createElement('div');
        d.className = 'band';
        d.textContent = `${b.type} · ${formatHz(b.freq)}${b.type.endsWith('pf') ? '' : ` · ${AddOnLogic.formatDb(b.gain)} dB`}${b.type === 'bell' ? ` · Q ${b.q.toFixed(2)}` : ''}`;
        return d;
      }));
    };
    eqView(ov.querySelector('.eq'), ch, eqSlots, b, { range: 18, label: ov.querySelector('.eqname'), readout });
    const close = () => { b.dispose(); ov.remove(); window.removeEventListener('keydown', onKey, true); eqLarge = null; };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('.x').onclick = close;
    document.body.append(ov);
    eqLarge = { close, id: ch.id };
  }

  // ---- dB ruler -----------------------------------------------------------------------------------
  // One scale at the left of the strips, lined up with the lanes (every lane has the same top and
  // height): the audio level in dBFS, as LUNA's meters mark it, 0 at the top.
  function renderRuler() {
    const ruler = $('ruler');
    const rl = ruler.querySelector('.rlane');
    const lane = document.querySelector('#strips .lane') ?? document.querySelector('#masterBox .lane');
    if (!lane) { rl.replaceChildren(); ruler.style.visibility = 'hidden'; return; }
    ruler.style.visibility = '';
    rl.style.top = `${lane.getBoundingClientRect().top - ruler.getBoundingClientRect().top}px`;
    rl.style.height = `${lane.clientHeight}px`;
    let head = ruler.querySelector('.rhead');
    if (!head) { head = document.createElement('div'); head.className = 'rhead'; head.innerHTML = 'AUDIO<br>dBFS'; ruler.append(head); }
    head.style.top = `${Math.max(2, lane.getBoundingClientRect().top - ruler.getBoundingClientRect().top - 30)}px`;
    rl.replaceChildren(...AddOnLogic.METER_MARKS.map((m) => {
      const d = document.createElement('div');
      d.className = `rmark${m === 0 ? ' zero' : ''}`;
      d.style.top = `${((1 - AddOnLogic.meterPos(m)) * 100).toFixed(2)}%`;
      d.textContent = m === 0 ? '0' : `−${-m}`;
      return d;
    }), Object.assign(document.createElement('div'), { className: 'hover' }));
  }
  /** Show the audio level (dBFS) at lane position `pos` (0 bottom, 1 top) on the ruler; null hides it. */
  function showRulerHover(pos) {
    const hv = $('ruler').querySelector('.hover');
    if (!hv) return;
    if (pos === null) { hv.classList.remove('on'); return; }
    hv.classList.add('on');
    hv.style.top = `${((1 - pos) * 100).toFixed(2)}%`;
    const db = AddOnLogic.meterDb(pos);
    hv.textContent = db === -Infinity ? '−∞' : AddOnLogic.formatDb(db).replace('.0', '');
    hv.title = 'Audio level at the pointer (dBFS)';
  }
  // Keep it lined up when the window or the strips change size.
  new ResizeObserver(() => renderRuler()).observe($('strips'));

  // ---- Transport bar -------------------------------------------------------------------------------
  let transportBindings = new Luna.Bindings();
  function bindTransport(s) {
    transportBindings.dispose();
    const tb = transportBindings = new Luna.Bindings();
    page.add(() => tb.dispose());
    const t = s.transport;
    $('rtz').onclick = () => t.returnToZero().catch(report);
    // Bar steps move the play start and keep the loop (a seek would reset the loop marks).
    $('barBack').onclick = () => t.setPlayStart({ bar: Math.max(1, AddOnLogic.currentBar(t) - 1) }).catch(report);
    $('barFwd').onclick = () => t.setPlayStart({ bar: AddOnLogic.currentBar(t) + 1 }).catch(report);
    $('stop').onclick = () => t.stop().catch(report);
    $('play').onclick = () => t.toggle().catch(report);
    $('rec').onclick = () => t.toggleRecord().catch(report);
    $('loop').onclick = () => t.looping.set(!t.looping.value).catch(report);
    const renderState = () => {
      const playing = t.playing.value === true;
      const rec = t.recordEnabled.value === true;
      $('play').classList.toggle('on', playing);
      $('rec').classList.toggle('on', rec);
      $('rec').classList.toggle('waiting', rec && !playing);
      $('loop').classList.toggle('on', t.looping.value === true);
    };
    const renderPos = () => {
      $('barbeat').textContent = Luna.formatBarBeat(t.location.value?.bar_beat);
      const bpm = t.tempo.value;
      $('tempo').textContent = typeof bpm === 'number' ? `${Math.round(bpm * 100) / 100} BPM` : '— BPM';
      $('sig').textContent = Luna.formatTimeSignature(t.timeSignature.value);
    };
    renderState(); renderPos();
    tb.on(t.playing, renderState);
    tb.on(t.recordEnabled, renderState);
    tb.on(t.looping, renderState);
    tb.on(t.location, renderPos);
    bindLunaMixerButton(tb);
    // Smooth MM:SS.s clock, interpolated between LUNA's location pushes while playing.
    tb.add(Luna.bindClock($('minsec'), t));
  }

  // "LUNA Mixer": show LUNA's own Mixer in its main window and fold this window down to a thin bar
  // (transport + a "Compact Mixer" button), so LUNA's mixer is in view. An Add On cannot hide its
  // own window, but it can resize it (AddOnInstance.resize). "Compact Mixer" unfolds it again at
  // its size and puts LUNA back on the page it showed before. Going to another page in LUNA itself
  // also unfolds it.
  const BAR_W = 560, BAR_H = 38;
  let me;                    // this page's AddOnInstance; undefined outside LUNA
  let folded = null;         // { w, h, back } while folded
  async function bindLunaMixerButton(tb) {
    const btn = $('lunaMixer');
    let ok = false;
    try { ok = await luna.gui.available(); if (ok) await luna.gui.windows.load(); } catch { ok = false; }
    btn.hidden = !ok;
    if (!ok) return;
    try { me = me ?? await luna.gui.thisInstance(); } catch { me = undefined; }
    const page = luna.gui.main.page;   // the main window's page: writable for mixer, timeline, home…
    let back = 'timeline';
    const render = () => {
      if (page.value && page.value !== 'mixer') back = page.value;
      btn.classList.toggle('on', !!folded);
      btn.querySelector('span').textContent = folded ? 'Compact Mixer' : 'LUNA Mixer';
      btn.title = folded ? 'Back to the Compact Mixer' : "Show LUNA's own Mixer and fold this window to a bar";
    };
    const fold = async () => {
      folded = { w: me?.width.value ?? window.innerWidth, h: me?.height.value ?? window.innerHeight, back };
      document.body.classList.add('folded');
      render();
      await page.set('mixer');
      if (me) await me.resize(Math.min(BAR_W, folded.w), BAR_H);
    };
    const unfold = async (returnPage = true) => {
      const f = folded;
      folded = null;
      document.body.classList.remove('folded');
      render();
      if (me && f) await me.resize(f.w, f.h);
      if (returnPage && f && page.value === 'mixer') await page.set(f.back);
      renderRuler();
    };
    render();
    tb.on(page, () => {
      render();
      if (folded && page.value && page.value !== 'mixer') unfold(false).catch(report);   // LUNA moved on by itself
    });
    btn.onclick = () => (folded ? unfold() : fold()).catch(report);
  }

  // ---- Start ---------------------------------------------------------------------------------
  async function connect() {
    for (;;) {
      try { luna = await Luna.connect(); break; }
      catch (e) {
        say(e instanceof Luna.NotRunning ? 'waiting for LUNA…' : String(e.message || e), !(e instanceof Luna.NotRunning));
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    Luna.bindShortcuts(luna, { onError: report });
    await luna.plugins.load().catch(() => undefined);   // names and categories for loaded plugins (fact 86)
    luna.status.onChange(() => {
      if (luna.status.value === 'connected') say(session?.name.value ?? '');
      else say('reconnecting to LUNA…', true);
    });
    await luna.sessions.ready();
    luna.sessions.focused.onChange(() => void build());
    await build();
  }
  renderToolbar();
  connect();
})();

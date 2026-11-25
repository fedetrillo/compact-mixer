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
  // The add-on's own colour, picked under the Look button.
  const ACCENTS = [['yellow', 'Yellow', '#ffd23f', '#f5a623'], ['orange', 'Orange', '#ffa94d', '#ff6b3d'], ['red', 'Red', '#ff6b6b', '#e0334f'], ['green', 'Green', '#2ee6a6', '#9be14a'], ['blue', 'Blue', '#4cc3ff', '#5b6cff'], ['pink', 'Pink', '#ff86c8', '#ff4f8b'], ['purple', 'Purple', '#c08bff', '#7b5cff']];
  const loadView = () => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && Array.isArray(v.kinds)) return { filter: { ...AddOnLogic.emptyFilter(), ...v.filter, kinds: v.kinds }, tiny: !!v.tiny, grey: !!v.grey, tint: Number.isFinite(v.tint) ? v.tint : 0, color: ACCENTS.some(([c]) => c === v.color) ? v.color : 'yellow' };
    } catch { /* storage unavailable or corrupt: start fresh */ }
    return { filter: AddOnLogic.emptyFilter(), tiny: false, grey: false, tint: 0, color: 'yellow' };
  };
  const view = loadView();
  const saveView = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ filter: { query: view.filter.query, color: view.filter.color }, kinds: view.filter.kinds, tiny: view.tiny, grey: view.grey, tint: view.tint, color: view.color })); }
    catch { /* not fatal */ }
  };
  // Pinned (always wide) channels, per session.
  const pinKey = (s) => `${STORE_KEY}.pins.${s.uid}`;
  const loadPins = (s) => { try { return new Set(JSON.parse(localStorage.getItem(pinKey(s)) || '[]')); } catch { return new Set(); } };
  const savePins = (s, pins) => { try { localStorage.setItem(pinKey(s), JSON.stringify([...pins])); } catch { /* not fatal */ } };
  // Folders collapsed here, and mix snapshots, per session.
  const setKey = (s, what) => `${STORE_KEY}.${what}.${s.uid}`;
  const loadJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
  const saveJson = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not fatal */ } };

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
  // Theme: dark (black background) or grey (a lighter grey background), kept with the view.
  const applyTheme = () => {
    document.body.classList.toggle('grey', view.grey);
    document.body.dataset.color = view.color;
    $('theme').title = 'Look: theme (dark or grey) and how much colour fills each strip';
    $('theme').classList.toggle('on', view.grey);
  };
  const applyTint = () => { document.body.style.setProperty('--tint', String((view.tint ?? 0) / 100)); };
  $('theme').onclick = () => {
    const p = openPop($('theme'), 'menu look');
    p.el.innerHTML = `<div class="chead">Theme</div>
      <div class="seg"><button data-t="dark">Dark</button><button data-t="grey">Grey</button></div>
      <div class="chead">Colour</div>
      <div class="accs">${ACCENTS.map(([c, name, a, b]) => `<button data-c="${c}" title="${name}" aria-label="${name}" style="background:linear-gradient(135deg,${a},${b})"></button>`).join('')}</div>
      <div class="chead">Strip colour <span class="tv"></span></div>
      <input class="tint" type="range" min="0" max="60" step="1">
      <div class="thint">How much of each channel's colour fills its strip</div>`;
    const seg = p.el.querySelectorAll('.seg button');
    const mark = () => seg.forEach((b) => b.classList.toggle('on', (b.dataset.t === 'grey') === view.grey));
    seg.forEach((b) => { b.onclick = () => { view.grey = b.dataset.t === 'grey'; applyTheme(); saveView(); mark(); }; });
    mark();
    const accs = p.el.querySelectorAll('.accs button');
    const markC = () => accs.forEach((b) => b.classList.toggle('on', b.dataset.c === view.color));
    accs.forEach((b) => { b.onclick = () => { view.color = b.dataset.c; applyTheme(); saveView(); markC(); }; });
    markC();
    const r = p.el.querySelector('.tint'), tv = p.el.querySelector('.tv');
    r.value = String(view.tint ?? 0);
    const show = () => { tv.textContent = `${r.value}%`; };
    show();
    r.oninput = () => { view.tint = Number(r.value); applyTint(); show(); };
    r.onchange = () => saveView();
    r.onkeydown = (e) => e.stopPropagation();
    p.place();
  };
  applyTint();
  applyTheme();
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
  let foldedFolders = new Set();             // folders collapsed here (their contents hidden)
  let nestDepth = 0;                  // deepest folder nesting among the shown strips
  let onFold = () => {};
  let groups = {};                    // fader groups: channel uid -> 1..8, per session
  let groupsOn = true;                // Groups button: off suspends every group
  let onGroupPick = () => {};
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
    foldedFolders = new Set(loadJson(setKey(s, 'foldedFolders'), []));
    onFold = (folder) => {
      if (foldedFolders.has(folder.id)) foldedFolders.delete(folder.id); else foldedFolders.add(folder.id);
      saveJson(setKey(s, 'foldedFolders'), [...foldedFolders]);
      void group.whenIdle(render);
    };
    bindSnapshots(s);
    collapsedId = null;
    say(s.name.value ?? '');
    page.on(s.name, () => say(s.name.value ?? ''));

    bindTransport(s);

    // Fader groups 1-8: the faders of a group move together by the same dB. Option/Alt while
    // dragging moves one alone; the Groups button suspends them all.
    groups = loadJson(setKey(s, 'groups'), {});
    const renderGroupsBtn = () => {
      const b = $('link');
      b.classList.toggle('on', groupsOn);
      b.classList.toggle('off', !groupsOn);
      b.textContent = groupsOn ? 'Groups' : 'Groups off';
      b.title = groupsOn ? 'Fader groups are on: faders in the same group move together. Click to suspend every group.' : 'Fader groups are suspended: every fader moves alone. Click to turn them back on.';
      document.body.classList.toggle('groups-off', !groupsOn);
    };
    $('link').onclick = () => { groupsOn = !groupsOn; renderGroupsBtn(); };
    renderGroupsBtn();
    onGroupPick = (ch, g) => {
      if (g) groups[ch.id] = g; else delete groups[ch.id];
      saveJson(setKey(s, 'groups'), groups);
      void group.whenIdle(render);
    };
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
      for (const el of document.querySelectorAll('.strip')) {
        el.classList.toggle('selected', sel.has(el.dataset.id));
      }
    };

    // Which strips are wide: the selected one (unless closed here) and the pinned ones.
    let selectedWide = null;
    let renderedKey = '';
    const selectionChanged = () => {
      const next = AddOnLogic.expandedId(s, AddOnLogic.shown(s, view.filter, foldedFolders), collapsedId);
      if (next !== selectedWide) void group.whenIdle(render);
      else renderSelection();
    };
    page.on(s.context.selectionTracks, () => { collapsedId = null; selectionChanged(); });
    page.on(s.context.lastSelectedTrack, selectionChanged);

    // Name click: select in LUNA (opens wide), or close/reopen the selected one here.
    onNameClick = (ch, e) => {
      // Cmd/Ctrl-click adds or removes a channel, Shift-click a run of them, as in LUNA.
      const toggle = !!(e && (e.metaKey || e.ctrlKey)), range = !!(e && e.shiftKey);
      if (toggle || range) {
        const cur = s.context.selectionTracks.value ?? [];
        const next = AddOnLogic.clickSelection(cur, s.context.lastSelectedTrack.value ?? cur.at(-1), ch, AddOnLogic.shown(s, view.filter, foldedFolders), { toggle, range });
        collapsedId = null;
        s.context.selectionTracks.set(next).then(() => (next.includes(ch.id) ? s.context.lastSelectedTrack.set(ch.id) : undefined)).catch(report);
        return;
      }
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
      const list = AddOnLogic.shown(s, view.filter, foldedFolders);
      await Promise.all(list.map((ch) => Promise.all([ch.loadStrip(), ch.controls.load()]).catch(() => undefined)));
      const selId = AddOnLogic.expandedId(s, list, collapsedId);
      nestDepth = Math.max(0, ...list.map((ch) => AddOnLogic.ancestors(s, ch).length + (ch.isFolder ? 1 : 0)));
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
      const shown = new Set(AddOnLogic.shown(s, view.filter, foldedFolders).map((c) => c.id));
      try {
        const moved = await AddOnLogic.move(s, ch, dir, shown);
        if (!moved) return;
        flashId = ch.id;
      } catch (e) { report(e); }
    };
    canMove = (ch, dir) => !!AddOnLogic.moveTarget(s, ch, dir, new Set(AddOnLogic.shown(s, view.filter, foldedFolders).map((c) => c.id)));
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
      <button class="grp" type="button"></button>
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

    // Folder nesting: one band per level, in each folder's colour, above the strip's own colour,
    // so a folder and everything inside it share a bracket. A folder has a fold button.
    const chain = AddOnLogic.ancestors(s, ch);
    if (ch.isFolder) chain.push(ch);
    if (nestDepth > 0 && info.kind !== 'master') {
      const nest = document.createElement('div');
      nest.className = 'nest';
      for (let i = 0; i < nestDepth; i++) {
        const band = document.createElement('i');
        const f = chain[i];
        if (f) {
          band.style.background = AddOnLogic.cssColor(f.color.value) ?? '#6a6a74';
          band.title = `In ${f.name.value ?? 'folder'}`;
          if (f === ch) band.className = 'start';
        }
        nest.append(band);
      }
      el.prepend(nest);
    }
    const colorBar = el.querySelector('.color');
    const renderColor = () => {
      const c = AddOnLogic.cssColor(ch.color.value);
      colorBar.style.background = c ?? (info.kind === 'master' ? 'var(--accent)' : '#555');
      if (c) el.style.setProperty('--c', c); else el.style.removeProperty('--c');   // the strip's tint
    };
    if (info.kind !== 'master') {
      colorBar.title = 'Click to change the colour (all selected channels when several are selected)';
      colorBar.onclick = (e) => { e.stopPropagation(); openColorMenu(colorBar, ch); };
    }
    renderColor();
    bindings.on(ch.color, renderColor);

    const name = el.querySelector('.name');
    const renderName = () => { const n = ch.name.value ?? ch.id; name.textContent = n; name.title = `${n} (${info.kind})`; };
    renderName();
    bindings.on(ch.name, renderName);
    if (ch.isFolder) {
      const shut = foldedFolders.has(ch.id);
      const n = AddOnLogic.folderSize(s, ch);
      const fold = document.createElement('button');
      fold.className = `fold${shut ? ' shut' : ''}`;
      fold.textContent = shut ? `▸ ${n}` : '▾';
      fold.title = shut ? `Show the ${n} channels inside ${ch.name.value ?? 'this folder'}` : `Hide what is inside ${ch.name.value ?? 'this folder'}`;
      fold.onclick = (e) => { e.stopPropagation(); onFold(ch); };
      el.querySelector('.head').append(fold);
      el.classList.toggle('shut', shut);
    }
    if (info.kind !== 'master') {
      name.onclick = (e) => onNameClick(ch, e);
      name.oncontextmenu = (e) => { e.preventDefault(); openColorMenu(e, ch); };
      name.title += `${wide && !pinned ? ' — click to narrow' : ' — click to select'}; Cmd/Ctrl-click or Shift-click to select several`;
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
    // Group chip: which fader group (1-8) the channel is in; click to choose.
    const grp = el.querySelector('.grp');
    if (grp) {
      const g = groups[ch.id];
      if (info.kind === 'cue' || info.kind === 'master') grp.remove();
      else {
        grp.textContent = g ? String(g) : '';
        grp.classList.toggle('set', !!g);
        if (g) grp.style.setProperty('--g', AddOnLogic.GROUP_COLORS[g - 1]);
        grp.title = g ? `Fader group ${g}: moves with the other channels of group ${g}. Click to change.` : 'No fader group. Click to put this channel in a group (1-8).';
        if (g) el.style.setProperty('--g', AddOnLogic.GROUP_COLORS[g - 1]);
        el.classList.toggle('grouped', !!g);
        grp.onclick = (e) => { e.stopPropagation(); openGroupMenu(grp, ch); };
      }
    }
    const db = el.querySelector('.db');
    const renderDb = () => { db.textContent = ch.gain.display.value ?? ''; };
    renderDb();
    bindings.on(ch.gain.display, renderDb);

    // Dragging anywhere on the lane moves the cap by the same distance (no jump on click), as
    // one undo step; double-click resets to LUNA's default, arrows nudge. pixelsPerUnit is the
    // lane's height, known once the strip is on screen: attach() runs after it is inserted.
    // Link: dragging a selected channel's fader moves the other selected ones by the same dB.
    let linked = null;   // while dragging: { from, others: [{ gain, taper, from }] }
    const startLink = (e) => {
      linked = null;
      if (!groupsOn || e?.altKey) return;
      const others = AddOnLogic.groupMates(s, groups, ch).map((c) => ({ gain: c.gain, taper: AddOnLogic.taperOf(c), from: c.gain.normalized.value ?? 0 }));
      if (!others.length) return;
      for (const o of others) o.gain.begin();
      linked = { from: ch.gain.normalized.value ?? 0, others };
    };
    const endLink = () => { if (linked) for (const o of linked.others) o.gain.end(); linked = null; };
    const onFader = (v) => {
      placeCap(v);
      if (!linked) return;
      for (const o of linked.others) o.gain.normalized.set(AddOnLogic.linkedValue(taper, linked.from, v, o.taper, o.from)).catch(report);
    };
    // Reset to 0 dB: Option/Alt-click or double-click, for the whole group when it has one.
    let downAt = null;
    lane.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; }, true);
    lane.addEventListener('click', (e) => {
      const still = downAt && Math.abs(e.clientX - downAt.x) < 3 && Math.abs(e.clientY - downAt.y) < 3;
      if (e.altKey && still) AddOnLogic.resetGrouped(s, groups, ch, groupsOn).catch(report);
    });
    lane.addEventListener('dblclick', () => AddOnLogic.resetGrouped(s, groups, ch, groupsOn).catch(report));
    const attach = () => {
      Luna.bindDrag(lane, ch.gain, {
        bindings, label: `${ch.name.value ?? ch.id} volume`, axis: 'y',
        pixelsPerUnit: Math.max(60, lane.clientHeight), step: 0.005, render: onFader,
        onBegin: (e) => { lane.classList.add('dragging'); startLink(e); },
        onEnd: () => { lane.classList.remove('dragging'); endLink(); },
        onError: report, reset: false,
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
      b.onclick = (e) => AddOnLogic.toggleGrouped(s, groups, ch, 'mute', groupsOn && !e.altKey).catch(report);
      buttons.append(b);
    }
    if (solo) {
      const b = document.createElement('button'); b.className = 'solo'; b.textContent = 'S'; b.title = 'Solo';
      const r = () => b.classList.toggle('on', solo.on); r(); bindings.on(solo.real, r);
      b.onclick = (e) => AddOnLogic.toggleGrouped(s, groups, ch, 'solo', groupsOn && !e.altKey).catch(report);
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
      // Effect inserts can change places: drag one onto another, or Move up / down.
      const used = ch.effectSlots.filter((sl) => !sl.isEmpty);
      const pos = used.indexOf(slot);
      const move = (to) => {
        say(`Moving ${name}…`);
        AddOnLogic.movePlugin(session, ch, pos, to).then(() => say(`Moved ${name}`)).catch(report);
      };
      if (pos >= 0 && used.length > 1) {
        row.draggable = true;
        row.dataset.pos = String(pos);
        row.ondragstart = (e) => { e.dataTransfer.setData('text/x-cm-insert', `${ch.id}:${pos}`); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); };
        row.ondragend = () => row.classList.remove('dragging');
        row.ondragover = (e) => { if ([...e.dataTransfer.types].includes('text/x-cm-insert')) { e.preventDefault(); row.classList.add('dropto'); } };
        row.ondragleave = () => row.classList.remove('dropto');
        row.ondrop = (e) => {
          e.preventDefault(); row.classList.remove('dropto');
          const [cid, p] = (e.dataTransfer.getData('text/x-cm-insert') || '').split(':');
          if (cid !== ch.id || Number(p) === pos) return;
          const name0 = used[Number(p)] ? AddOnLogic.slotName(used[Number(p)], pluginName) : '';
          say(`Moving ${name0}…`);
          AddOnLogic.movePlugin(session, ch, Number(p), pos).then(() => say(`Moved ${name0}`)).catch(report);
        };
      }
      row.oncontextmenu = (e) => {
        e.preventDefault();
        openMenu(e, [
          ...(pos > 0 ? [{ label: 'Move up', run: () => move(pos - 1) }] : []),
          ...(pos >= 0 && pos < used.length - 1 ? [{ label: 'Move down', run: () => move(pos + 1) }] : []),
          { label: 'Replace…', run: () => { if (slot.editorOpen.value === true) slot.closeEditor({ timeoutMs: 3000 }).catch(() => undefined); openPluginPicker(nm, ch, slot, name); } },
          { label: slot.in.value === false ? 'Turn on' : 'Bypass', run: () => slot.setIn(slot.in.value === false).catch(report) },
          { label: 'Remove', danger: true, run: () => { say(`Removing ${name}…`); AddOnLogic.removePlugin(slot).then(() => say(`Removed ${name}`)).catch(report); } },
        ]);
      };
      insBox.append(row);
    }
    const free = AddOnLogic.freeEffectSlot(ch);
    if (free) {
      const add = document.createElement('button');
      add.className = 'addrow'; add.textContent = '+ Plugin';
      add.title = 'Load a plugin in the next free insert';
      add.onclick = () => openPluginPicker(add, ch, free);
      insBox.append(add);
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
      row.oncontextmenu = (e) => {
        e.preventDefault();
        openMenu(e, [
          { label: 'Change bus…', run: () => openBusPicker(row, ch, send) },
          { label: 'Remove', danger: true, run: () => send.unassign().then(() => say(`Removed send to ${to}`)).catch(report) },
        ]);
      };
      sendBox.append(row);
    }
    if (AddOnLogic.freeSend(ch)) {
      const add = document.createElement('button');
      add.className = 'addrow'; add.textContent = '+ Send';
      add.title = 'Send this channel to a bus (starts at -inf)';
      add.onclick = () => openBusPicker(add, ch);
      sendBox.append(add);
    }
  }

  // ---- Mix snapshots ---------------------------------------------------------------------------
  // Faders, mutes, solos, pans and send levels, saved under a name and put back with a click (one
  // undo step). Kept on this computer, per session.
  let snapState = null;   // { s, list: [{ name, at, mix }], current }
  function bindSnapshots(s) {
    snapState = { s, list: loadJson(setKey(s, 'snaps'), []), current: null };
    $('snaps').onclick = () => openSnapshots($('snaps'));
  }
  const saveSnaps = () => saveJson(setKey(snapState.s, 'snaps'), snapState.list);
  async function openSnapshots(anchor) {
    const { s } = snapState;
    const p = openPop(anchor, 'picker snaps');
    p.el.innerHTML = '<div class="pnone">Reading the mix…</div>';
    p.place();
    try { await AddOnLogic.loadForSnapshot(s); } catch (e) { p.close(); report(e); return; }
    if (pop !== p) return;
    const draw = () => {
      p.el.innerHTML = '<div class="snapnew"><input class="psearch" spellcheck="false" maxlength="40"><button class="snapsave">Save</button></div><div class="plist"></div>';
      const input = p.el.querySelector('input');
      input.placeholder = `Name, e.g. Mix ${snapState.list.length + 1}`;
      const save = () => {
        const name = input.value.trim() || `Mix ${snapState.list.length + 1}`;
        const at = Date.now();
        const existing = snapState.list.find((x) => x.name === name);
        if (existing) { existing.mix = AddOnLogic.captureMix(s); existing.at = at; } else snapState.list.push({ name, at, mix: AddOnLogic.captureMix(s) });
        snapState.current = name;
        saveSnaps();
        say(`Saved snapshot “${name}”`);
        draw();
      };
      p.el.querySelector('.snapsave').onclick = save;
      input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save(); } };
      const list = p.el.querySelector('.plist');
      if (!snapState.list.length) list.innerHTML = '<div class="pnone">No snapshots yet. Type a name and Save to keep the mix as it is now.</div>';
      for (const snap of snapState.list) {
        const diff = AddOnLogic.mixDiff(s, snap.mix);
        const row = document.createElement('div');
        row.className = `snap${snap.name === snapState.current && diff === 0 ? ' current' : ''}`;
        row.innerHTML = '<button class="snapgo"><span class="pl"></span><span class="ps"></span></button><button class="snapup" title="Update: save the mix as it is now under this name">⟳</button><button class="snapdel" title="Delete">✕</button>';
        row.querySelector('.pl').textContent = snap.name;
        row.querySelector('.ps').textContent = diff === 0 ? 'as now' : `${diff} change${diff === 1 ? '' : 's'}`;
        row.querySelector('.snapgo').title = diff === 0 ? 'The mix is as this snapshot has it' : `Recall “${snap.name}” (${diff} values change; Cmd+Z undoes it)`;
        row.querySelector('.snapgo').onclick = async () => {
          try {
            const n = await AddOnLogic.recallMix(s, snap.mix, snap.name);
            snapState.current = snap.name;
            say(n ? `Recalled “${snap.name}”` : `“${snap.name}” is already the mix`);
            setTimeout(draw, 300);
          } catch (e) { report(e); }
        };
        row.querySelector('.snapup').onclick = () => { snap.mix = AddOnLogic.captureMix(s); snap.at = Date.now(); snapState.current = snap.name; saveSnaps(); say(`Updated “${snap.name}”`); draw(); };
        row.querySelector('.snapdel').onclick = () => { snapState.list = snapState.list.filter((x) => x !== snap); saveSnaps(); draw(); };
        list.append(row);
      }
      p.place();
      input.focus();
    };
    draw();
  }

  // ---- Pop-ups: right-click menus, the plugin browser and the bus list ---------------------------
  // One at a time, in the page (not inside a strip, which can be rebuilt under it). Esc, a click
  // outside or picking something closes it.
  let pop = null;
  function closePop() { pop?.close(); }
  function openPop(at, cls) {
    closePop();
    const el = document.createElement('div');
    el.className = `pop ${cls}`;
    document.body.append(el);
    const place = () => {
      const r = at instanceof Event ? { left: at.clientX, right: at.clientX, top: at.clientY, bottom: at.clientY } : at.getBoundingClientRect();
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(4, Math.min(r.left, vw - w - 4));
      const below = r.bottom + 2, above = r.top - h - 2;
      el.style.left = `${left}px`;
      el.style.top = `${below + h <= vh - 4 || above < 4 ? Math.max(4, Math.min(below, vh - h - 4)) : above}px`;
    };
    const onDown = (e) => { if (!el.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    const close = () => {
      if (pop?.el !== el) return;
      pop = null;
      el.remove();
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    pop = { el, close, place };
    return pop;
  }

  function openColorMenu(at, ch) {
    const p = openPop(at, 'menu colors');
    const sel = session.context.selectionTracks.value ?? [];
    const many = sel.length > 1 && sel.includes(ch.id);
    const head = document.createElement('div');
    head.className = 'chead';
    head.textContent = many ? `Colour for ${sel.length} channels` : `Colour for ${ch.name.value ?? ''}`;
    const grid = document.createElement('div');
    grid.className = 'cgrid';
    for (const argb of AddOnLogic.PALETTE) {
      const b = document.createElement('button');
      b.className = `csw${(ch.color.value >>> 0) === (argb >>> 0) ? ' cur' : ''}`;
      b.style.background = AddOnLogic.cssColor(argb);
      b.title = AddOnLogic.cssColor(argb);
      b.onclick = () => { p.close(); AddOnLogic.setColor(session, ch, argb).then((n) => say(n > 1 ? `Coloured ${n} channels` : `Coloured ${ch.name.value ?? ''}`)).catch(report); };
      grid.append(b);
    }
    p.el.append(head, grid);
    p.place();
    grid.querySelector('.cur, button')?.focus();
  }

  function openGroupMenu(anchor, ch) {
    const counts = AddOnLogic.groupCounts(session, groups);
    const p = openPop(anchor, 'menu groups');
    const cur = groups[ch.id] ?? 0;
    const add = (g) => {
      const b = document.createElement('button');
      b.className = `gitem${g === cur ? ' cur' : ''}`;
      b.innerHTML = '<i></i><span class="gl"></span><span class="gn"></span>';
      if (g) b.firstChild.style.background = AddOnLogic.GROUP_COLORS[g - 1];
      b.querySelector('.gl').textContent = g ? `Group ${g}` : 'No group';
      b.querySelector('.gn').textContent = g && counts[g] ? String(counts[g]) : '';
      b.onclick = () => { p.close(); onGroupPick(ch, g); };
      p.el.append(b);
    };
    for (let g = 1; g <= 8; g++) add(g);
    add(0);
    p.place();
    p.el.querySelector('.cur, button')?.focus();
  }

  function openMenu(e, items) {
    const p = openPop(e, 'menu');
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.onclick = () => { p.close(); it.run(); };
      p.el.append(b);
    }
    p.place();
    p.el.querySelector('button')?.focus();
  }

  /**
   * A searchable list: type to narrow, arrows to move, Enter or a click to pick. `groups` is
   * [{ title, rows }]; each row { label, sub, value }. `extra` adds a row at the end.
   */
  function pickList(p, { placeholder, groups, onPick, empty = 'Nothing found' }) {
    p.el.innerHTML = '<input class="psearch" type="search" spellcheck="false"><div class="plist"></div>';
    const input = p.el.querySelector('input');
    const list = p.el.querySelector('.plist');
    input.placeholder = placeholder;
    let rows = [];
    let active = 0;
    const mark = () => rows.forEach((b, i) => b.classList.toggle('active', i === active));
    const draw = () => {
      list.replaceChildren(); rows = []; active = 0;
      for (const g of groups(input.value)) {
        if (!g.rows.length) continue;
        if (g.title) { const h = document.createElement('div'); h.className = 'pgroup'; h.textContent = g.title; list.append(h); }
        for (const r of g.rows) {
          const b = document.createElement('button');
          b.className = 'pitem';
          b.innerHTML = '<span class="pl"></span><span class="ps"></span>';
          b.firstChild.textContent = r.label;
          b.lastChild.textContent = r.sub ?? '';
          const i = rows.length;
          b.onmouseenter = () => { active = i; mark(); };
          b.onclick = () => { if (!r.keepOpen) p.close(); onPick(r.value); };
          rows.push(b); list.append(b);
        }
      }
      if (!rows.length) { const n = document.createElement('div'); n.className = 'pnone'; n.textContent = empty; list.append(n); }
      mark();
    };
    input.oninput = draw;
    input.onkeydown = (e) => {
      e.stopPropagation();   // typing here is not a shortcut
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!rows.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        mark(); rows[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') { e.preventDefault(); rows[active]?.click(); }
    };
    draw();
    p.place();
    input.focus();
    return { redraw: draw, input };
  }

  // Plugin browser: the plugins LUNA would offer in that slot, by category; type to search.
  const pluginCache = new Map();   // `${channel}:${slot}` -> rows, kept for a minute
  async function openPluginPicker(anchor, ch, slot, replacing = null) {
    const p = openPop(anchor, 'picker');
    p.el.innerHTML = '<div class="pnone">Loading plugins…</div>';
    p.place();
    const key = `${ch.id}:${slot.id}`;
    let rows = pluginCache.get(key)?.at > Date.now() - 60000 ? pluginCache.get(key).rows : null;
    if (!rows) {
      try { rows = await AddOnLogic.pluginChoices(luna, slot); } catch (e) { p.close(); report(e); return; }
      pluginCache.set(key, { rows, at: Date.now() });
    }
    if (pop !== p) return;   // closed while loading
    const chName = ch.name.value ?? '';
    pickList(p, {
      placeholder: replacing ? `Replace ${replacing} with…` : `Plugin for ${chName}…`,
      empty: 'No plugin matches',
      groups: (text) => AddOnLogic.groupPlugins(rows, text).map((g) => ({ title: g.title, rows: g.rows.map((r) => ({ label: r.name, sub: r.manufacturer, value: r })) })),
      onPick: async (r) => {
        say(`Loading ${r.name} on ${chName}…`);
        try { await AddOnLogic.addPlugin(ch, r.pluginId, slot); say(`${r.name} on ${chName}`); } catch (e) { report(e); }
      },
    });
  }

  // Bus list for a new send (or to move one): every aux bus, plus "New bus…" to make one.
  function openBusPicker(anchor, ch, send = null) {
    const s = session;
    const p = openPop(anchor, 'picker');
    const chName = ch.name.value ?? '';
    const NEW = {};
    let naming = false;   // after "New bus…" with nothing typed: the box asks for the name
    const list = pickList(p, {
      placeholder: send ? 'Move send to…' : `Send ${chName} to…`,
      empty: 'No bus matches',
      groups: (text) => {
        if (naming) return [{ title: null, rows: [{ label: text.trim() ? `Create bus “${text.trim()}”` : 'Type the name, then Enter', sub: '', value: NEW, keepOpen: !text.trim() }] }];
        const t = text.trim().toLowerCase();
        const buses = AddOnLogic.sendTargets(s, ch).filter((b) => (b.name.value ?? '').toLowerCase().includes(t));
        const make = { label: text.trim() ? `New bus “${text.trim()}”` : 'New bus…', sub: '', value: NEW, keepOpen: !text.trim() };
        return [{ title: null, rows: [...buses.map((b) => ({ label: b.name.value ?? b.id, sub: '', value: b })), make] }];
      },
      onPick: async (b) => {
        let target = b;
        if (b === NEW) {
          const name = list.input.value.trim();
          if (!name) { naming = true; list.input.placeholder = 'Name of the new bus'; list.redraw(); list.input.focus(); return; }
          p.close();
          target = { newName: name };
        }
        try {
          if (send) {
            const bus = target.newName !== undefined ? await s.newBus({ name: target.newName }) : target;
            await send.retarget(bus.id, 'Compact Mixer: change send');
            say(`${chName} now sends to ${bus.name.value ?? ''}`);
          } else {
            const { bus } = await AddOnLogic.addSend(s, ch, target);
            say(`${chName} sends to ${bus.name.value ?? ''} (at -inf: raise it with its fader)`);
          }
        } catch (e) { report(e); }
      },
    });
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

    // A/B, shared with the AB Monitor Add On through LUNA itself (the two buses' mutes).
    let abCue;
    let abOffs = [];
    const renderAB = () => {
      const st = AddOnLogic.abState(s, abCue);
      const ready = !!abCue;
      for (const [id, x] of [['abA', 'A'], ['abB', 'B']]) {
        $(id).disabled = !ready;
        $(id).classList.toggle('on', ready && (st === x || st === 'both'));
        $(id).title = !ready ? 'Prepare MIX in the AB Monitor Add On to use A/B here'
          : x === 'A' ? 'Listen on A (Main Output)' : `Listen on B (${abCue.name.value ?? 'cue'})`;
      }
    };
    const findAB = async () => {
      await AddOnLogic.abLoad(s);
      const cue = AddOnLogic.abCue(s);
      if (cue !== abCue) {
        abCue = cue;
        abOffs.forEach((off) => off()); abOffs = [];
        for (const bus of [s.master, cue].filter(Boolean)) abOffs.push(bus.mute.real.onChange(renderAB));
      }
      renderAB();
    };
    tb.add(() => abOffs.forEach((off) => off()));
    $('abA').onclick = () => abCue && AddOnLogic.abListen(s, abCue, 'A').catch(report);
    $('abB').onclick = () => abCue && AddOnLogic.abListen(s, abCue, 'B').catch(report);
    tb.on(s.buses, () => void findAB().catch(() => undefined));
    const abTimer = setInterval(() => { if (!document.hidden) void findAB().catch(() => undefined); }, 2000);   // MIX or its cue set later in AB Monitor
    tb.add(() => clearInterval(abTimer));
    void findAB().catch(() => undefined);
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
  const BAR_W = 640, BAR_H = 38;
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

  // ---- Name and version ----------------------------------------------------------------------
  // Written here (a test checks it matches manifest.json). Updates come through LUNA's own Add On
  // marketplace notice, so the page asks no server.
  const VERSION = '1.2.1';
  const showVersion = () => { $('appver').textContent = `v${VERSION}`; };


  // ---- Quick guide ---------------------------------------------------------------------------
  // The mixer itself is in English; its short guide comes in seven languages, chosen first.
  const GUIDE = {"en": {"help": "Quick guide", "helpBtn": "Guide", "tNext": "Next", "tBack": "Back", "tSkip": "Skip", "tDone": "Got it", "zt": "Always at hand", "z": "Open this guide again whenever you need it with the Guide button.", "_name": "English", "langT": "Choose the guide’s language", "langX": "This short guide will use it.", "q1t": "Transport", "q1": "Return to zero, jump a bar, stop, play, record and loop, with the position and tempo. LUNA Mixer shows LUNA’s own mixer and folds this window to a thin bar; A / B switches speakers with AB Monitor.", "q2t": "Find your channels", "q2": "Filter by name (commas for several: vox, gtr), by kind and by track colour. Show all brings every channel back.", "q3t": "The strips", "q3": "The lane is the meter and the fader: drag anywhere on it, double-click for 0 dB. Click a channel to open it wide with inserts, EQ, sends and pan; the chip under the fader puts it in a fader group.", "q4t": "Mix tools", "q4": "Snapshots saves the mix and recalls it in one click. Groups suspends the fader groups, S and M clear every solo and mute, ⇔ changes the strip width and ◐ the theme and colour."}, "es": {"help": "Guía rápida", "helpBtn": "Guía", "tNext": "Siguiente", "tBack": "Atrás", "tSkip": "Saltar", "tDone": "Entendido", "zt": "Siempre a mano", "z": "Vuelve a esta guía cuando la necesites con el botón Guía.", "_name": "Español", "langT": "Elige el idioma de la guía", "langX": "Esta guía rápida lo usará.", "q1t": "Transporte", "q1": "Volver al inicio, saltar un compás, parar, reproducir, grabar y loop, con la posición y el tempo. LUNA Mixer muestra el mezclador de LUNA y pliega esta ventana a una barra fina; A / B cambia de altavoces junto con AB Monitor.", "q2t": "Encuentra tus canales", "q2": "Filtra por nombre (con comas para varios: vox, gtr), por tipo y por color de pista. Show all vuelve a mostrarlos todos.", "q3t": "Las tiras", "q3": "El carril es el medidor y el fader: arrastra en cualquier punto, doble clic para 0 dB. Haz clic en un canal para abrirlo ancho con inserts, EQ, envíos y panorama; la pastilla bajo el fader lo mete en un grupo de faders.", "q4t": "Herramientas de mezcla", "q4": "Snapshots guarda la mezcla y la recupera con un clic. Groups suspende los grupos de faders, S y M quitan todos los solos y mutes, ⇔ cambia el ancho de las tiras y ◐ el tema y el color."}, "ca": {"help": "Guia ràpida", "helpBtn": "Guia", "tNext": "Següent", "tBack": "Enrere", "tSkip": "Saltar", "tDone": "Entesos", "zt": "Sempre a mà", "z": "Torna a aquesta guia quan la necessitis amb el botó Guia.", "_name": "Català", "langT": "Tria l’idioma de la guia", "langX": "Aquesta guia ràpida el farà servir.", "q1t": "Transport", "q1": "Tornar a l’inici, saltar un compàs, aturar, reproduir, gravar i loop, amb la posició i el tempo. LUNA Mixer mostra el mesclador de LUNA i plega aquesta finestra a una barra fina; A / B canvia d’altaveus juntament amb AB Monitor.", "q2t": "Troba els teus canals", "q2": "Filtra per nom (amb comes per a diversos: vox, gtr), per tipus i per color de pista. Show all torna a mostrar-los tots.", "q3t": "Les tires", "q3": "El carril és el mesurador i el fader: arrossega en qualsevol punt, doble clic per a 0 dB. Fes clic en un canal per obrir-lo ample amb inserts, EQ, envios i panorama; la pastilla sota el fader el posa en un grup de faders.", "q4t": "Eines de mescla", "q4": "Snapshots desa la mescla i la recupera amb un clic. Groups suspèn els grups de faders, S i M treuen tots els solos i mutes, ⇔ canvia l’amplada de les tires i ◐ el tema i el color."}, "fr": {"help": "Guide rapide", "helpBtn": "Guide", "tNext": "Suivant", "tBack": "Retour", "tSkip": "Passer", "tDone": "Compris", "zt": "Toujours à portée", "z": "Rouvrez ce guide quand vous voulez avec le bouton Guide.", "_name": "Français", "langT": "Choisissez la langue du guide", "langX": "Ce petit guide l’utilisera.", "q1t": "Transport", "q1": "Retour au début, une mesure avant ou arrière, stop, lecture, enregistrement et boucle, avec la position et le tempo. LUNA Mixer affiche la console de LUNA et replie cette fenêtre en une fine barre ; A / B change d’enceintes avec AB Monitor.", "q2t": "Trouvez vos canaux", "q2": "Filtrez par nom (virgules pour plusieurs : vox, gtr), par type et par couleur de piste. Show all les réaffiche tous.", "q3t": "Les tranches", "q3": "La piste est à la fois le vumètre et le fader : faites glisser n’importe où, double-clic pour 0 dB. Cliquez sur un canal pour l’ouvrir en large avec inserts, EQ, envois et panoramique ; la pastille sous le fader le met dans un groupe de faders.", "q4t": "Outils de mixage", "q4": "Snapshots enregistre le mix et le rappelle en un clic. Groups suspend les groupes de faders, S et M retirent tous les solos et mutes, ⇔ change la largeur des tranches et ◐ le thème et la couleur."}, "de": {"help": "Kurzanleitung", "helpBtn": "Anleitung", "tNext": "Weiter", "tBack": "Zurück", "tSkip": "Überspringen", "tDone": "Verstanden", "zt": "Immer zur Hand", "z": "Öffne diese Anleitung jederzeit wieder mit dem Button Anleitung.", "_name": "Deutsch", "langT": "Wähle die Sprache der Anleitung", "langX": "Diese kurze Anleitung verwendet sie.", "q1t": "Transport", "q1": "Zum Anfang, einen Takt vor oder zurück, Stopp, Wiedergabe, Aufnahme und Loop, mit Position und Tempo. LUNA Mixer zeigt LUNAs eigenen Mixer und klappt dieses Fenster zu einer schmalen Leiste; A / B schaltet die Lautsprecher zusammen mit AB Monitor um.", "q2t": "Finde deine Kanäle", "q2": "Filtere nach Name (Kommas für mehrere: vox, gtr), nach Art und nach Spurfarbe. Show all zeigt wieder alle.", "q3t": "Die Kanalzüge", "q3": "Die Bahn ist Meter und Fader zugleich: irgendwo ziehen, Doppelklick für 0 dB. Klicke einen Kanal an, um ihn breit mit Inserts, EQ, Sends und Panorama zu öffnen; der Chip unter dem Fader setzt ihn in eine Fadergruppe.", "q4t": "Mix-Werkzeuge", "q4": "Snapshots speichert den Mix und ruft ihn mit einem Klick ab. Groups setzt die Fadergruppen aus, S und M heben alle Solos und Mutes auf, ⇔ ändert die Breite der Kanalzüge und ◐ Theme und Farbe."}, "it": {"help": "Guida rapida", "helpBtn": "Guida", "tNext": "Avanti", "tBack": "Indietro", "tSkip": "Salta", "tDone": "Capito", "zt": "Sempre a portata di mano", "z": "Riapri questa guida quando ti serve con il pulsante Guida.", "_name": "Italiano", "langT": "Scegli la lingua della guida", "langX": "Questa breve guida la userà.", "q1t": "Trasporto", "q1": "Torna all’inizio, salta una battuta, stop, play, registrazione e loop, con posizione e tempo. LUNA Mixer mostra il mixer di LUNA e riduce questa finestra a una barra sottile; A / B cambia diffusori insieme ad AB Monitor.", "q2t": "Trova i tuoi canali", "q2": "Filtra per nome (virgole per più nomi: vox, gtr), per tipo e per colore di traccia. Show all li mostra di nuovo tutti.", "q3t": "I canali", "q3": "La corsia è sia il meter sia il fader: trascina in qualsiasi punto, doppio clic per 0 dB. Clicca un canale per aprirlo largo con insert, EQ, mandate e pan; il chip sotto il fader lo mette in un gruppo di fader.", "q4t": "Strumenti di mix", "q4": "Snapshots salva il mix e lo richiama con un clic. Groups sospende i gruppi di fader, S e M tolgono tutti i solo e i mute, ⇔ cambia la larghezza dei canali e ◐ tema e colore."}, "pt": {"help": "Guia rápido", "helpBtn": "Guia", "tNext": "Seguinte", "tBack": "Voltar", "tSkip": "Saltar", "tDone": "Percebi", "zt": "Sempre à mão", "z": "Volta a este guia quando precisares com o botão Guia.", "_name": "Português", "langT": "Escolhe o idioma do guia", "langX": "Este guia rápido vai usá-lo.", "q1t": "Transporte", "q1": "Voltar ao início, saltar um compasso, parar, reproduzir, gravar e loop, com a posição e o tempo. LUNA Mixer mostra a mesa do LUNA e dobra esta janela numa barra fina; A / B troca de colunas em conjunto com o AB Monitor.", "q2t": "Encontra os teus canais", "q2": "Filtra por nome (vírgulas para vários: vox, gtr), por tipo e por cor da faixa. Show all volta a mostrar todos.", "q3t": "As tiras", "q3": "A faixa é ao mesmo tempo o medidor e o fader: arrasta em qualquer ponto, duplo clique para 0 dB. Clica num canal para o abrir largo com inserts, EQ, envios e pan; a pastilha por baixo do fader põe-no num grupo de faders.", "q4t": "Ferramentas de mistura", "q4": "Snapshots guarda a mistura e recupera-a com um clique. Groups suspende os grupos de faders, S e M tiram todos os solos e mutes, ⇔ muda a largura das tiras e ◐ o tema e a cor."}};
  const GKEY = 'com.fedetrillo.compactmixer.';
  let glang = (() => {
    try { const v = localStorage.getItem(GKEY + 'guideLang'); if (GUIDE[v]) return v; } catch { /* not fatal */ }
    for (const l of navigator.languages ?? [navigator.language]) { const c = String(l || '').slice(0, 2).toLowerCase(); if (GUIDE[c]) return c; }
    return 'en';
  })();
  const gt = (k) => GUIDE[glang]?.[k] ?? GUIDE.en[k] ?? k;
  const paintHelp = () => { const q = document.createElement('b'); q.textContent = '?'; const sp = document.createElement('span'); sp.textContent = gt('helpBtn'); document.getElementById('help').replaceChildren(q, sp); document.getElementById('help').title = gt('help'); };
  let tour = null;
  function attachGuide() {
    paintHelp();
    tour ??= window.AddOnTour?.attach({
      button: document.getElementById('help'), key: GKEY + 'tourSeen',
      labels: () => ({ next: gt('tNext'), back: gt('tBack'), skip: gt('tSkip'), done: gt('tDone') }),
      language: {
        sel: '#help',
        list: () => Object.keys(GUIDE).map((c) => [c, GUIDE[c]._name]),
        current: () => glang,
        set: (c) => { glang = c; try { localStorage.setItem(GKEY + 'guideLang', c); } catch { /* not fatal */ } paintHelp(); },
        title: () => gt('langT'), text: () => gt('langX'),
      },
      steps: () => [
        { sel: 'header.transport', title: () => gt('q1t'), text: () => gt('q1') },
        { sel: 'header.tools', title: () => gt('q2t'), text: () => gt('q2') },
        { sel: '#strips', title: () => gt('q3t'), text: () => gt('q3') },
        { sel: '#snaps', title: () => gt('q4t'), text: () => gt('q4') },
        { sel: '#help', title: () => gt('zt'), text: () => gt('z') },
      ],
    });
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
    showVersion();
    await luna.plugins.load().catch(() => undefined);   // names and categories for loaded plugins (fact 86)
    luna.status.onChange(() => {
      if (luna.status.value === 'connected') say(session?.name.value ?? '');
      else say('reconnecting to LUNA…', true);
    });
    await luna.sessions.ready();
    luna.sessions.focused.onChange(() => void build());
    await build();
    attachGuide();
  }
  renderToolbar();
  paintHelp();
  connect();
})();

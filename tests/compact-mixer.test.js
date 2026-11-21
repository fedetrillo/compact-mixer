// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const logic = globalThis.AddOnLogic;

const RED = 0xffd04040;
const BLUE = 0xff4070d0;

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Lead Vox', 'BG Vox', 'Gtr L', 'Gtr R'] });
  engine.addTrack('abc', 'keys', { name: 'Keys', trackType: 'instrument' });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.newBus({ name: 'Reverb' });
  await engine.settled();
  await luna.settled();
  const all = logic.channels(session);
  await Promise.all(all.map((ch) => Promise.all([ch.loadStrip(), ch.controls.load()])));
  const byName = (n) => all.find((ch) => ch.name.value === n);
  await byName('Lead Vox').color.set(RED);
  await byName('BG Vox').color.set(RED);
  await byName('Gtr L').color.set(BLUE);
  await engine.settled();
  await luna.settled();
  return { engine, luna, session, byName };
}

const names = (chs) => chs.map((ch) => ch.name.value);

describe('Compact Mixer', () => {
  it('lists tracks, then buses, then the master last', async () => {
    const { session } = await connected();
    const chs = logic.channels(session);
    expect(names(chs).slice(0, 5)).toEqual(['Lead Vox', 'BG Vox', 'Gtr L', 'Gtr R', 'Keys']);
    expect(logic.kindOf(chs.at(-1))).toBe('master');
    expect(chs.map((c) => logic.kindOf(c)).slice(3, 5)).toEqual(['audio', 'instrument']);
    expect(logic.kindOf(chs.find((c) => c.name.value === 'Reverb'))).toBe('bus');
  });

  it('filters by name, with commas as alternatives, and keeps the master', async () => {
    const { session } = await connected();
    const f = { ...logic.emptyFilter(), query: 'vox' };
    expect(names(logic.filtered(session, f)).slice(0, -1)).toEqual(['Lead Vox', 'BG Vox']);
    f.query = 'VOX, keys';
    expect(names(logic.filtered(session, f)).slice(0, -1)).toEqual(['Lead Vox', 'BG Vox', 'Keys']);
    expect(logic.kindOf(logic.filtered(session, f).at(-1))).toBe('master');
  });

  it('filters by kind', async () => {
    const { session } = await connected();
    const f = { ...logic.emptyFilter(), kinds: ['instrument', 'bus'] };
    expect(names(logic.filtered(session, f)).slice(0, -1)).toEqual(['Keys', 'Reverb']);
    expect(logic.isEmptyFilter(f)).toBe(false);
    expect(logic.isEmptyFilter(logic.emptyFilter())).toBe(true);
  });

  it('hides cue mixes until asked for', async () => {
    const { session } = await connected();
    const shown = names(logic.filtered(session, logic.emptyFilter()));
    expect(shown.some((n) => n.startsWith('CUE'))).toBe(false);
    expect(shown).toContain('Reverb');
    const f = { ...logic.emptyFilter(), kinds: ['cue'] };
    expect(names(logic.filtered(session, f)).slice(0, -1)).toEqual(['CUE 1', 'CUE 2', 'CUE 3', 'CUE 4']);
  });

  it('collects colours and filters by one', async () => {
    const { session } = await connected();
    const colors = logic.colors(session);
    expect(colors.slice(0, 2)).toEqual(['#d04040', '#4070d0']);
    expect(logic.colors(session, ['bus']).includes('#d04040')).toBe(false);
    const f = { ...logic.emptyFilter(), color: '#d04040' };
    expect(names(logic.filtered(session, f)).slice(0, -1)).toEqual(['Lead Vox', 'BG Vox']);
  });

  it('clears every solo in one undo step', async () => {
    const { engine, session, byName } = await connected();
    await logic.soloOf(byName('Gtr L')).toggle();
    await logic.soloOf(byName('Keys')).toggle();
    await engine.settled();
    expect(logic.counts(session).soloed).toBe(2);
    engine.transactions.length = 0;
    await logic.clearSolos(session);
    await engine.settled();
    expect(logic.counts(session).soloed).toBe(0);
    expect(engine.transactions).toEqual(['begin', 'commit']);
  });

  it('unmutes everything in one undo step', async () => {
    const { engine, session, byName } = await connected();
    await byName('Lead Vox').mute.toggle();
    await byName('Reverb').mute.toggle();
    await engine.settled();
    expect(logic.counts(session).muted).toBe(2);
    engine.transactions.length = 0;
    await logic.unmuteAll(session);
    await engine.settled();
    expect(logic.counts(session).muted).toBe(0);
    expect(engine.transactions).toEqual(['begin', 'commit']);
  });

  it('touches mute once per click, so it is one undo step', async () => {
    const { engine, byName } = await connected();
    engine.touches.length = 0;
    await byName('BG Vox').mute.toggle();
    await engine.settled();
    expect(engine.touches.filter((t) => t.endsWith(':on')).length).toBe(1);
    expect(engine.touches.filter((t) => t.endsWith(':off')).length).toBe(1);
  });

  it('selects a track in LUNA', async () => {
    const { engine, session, byName } = await connected();
    await logic.select(session, byName('Gtr R'));
    await engine.settled();
    expect(session.context.selectionTracks.value).toEqual([byName('Gtr R').id]);
    expect(session.context.lastSelectedTrack.value).toBe(byName('Gtr R').id);
  });

  it('puts meter levels on an audio scale like LUNA\'s', () => {
    const M = logic.METER_MARKS;
    expect(logic.meterPosition(0)).toBe(0);
    expect(logic.meterPosition(1)).toBe(1);                         // 0 dBFS at the top
    expect(logic.meterPosition(2)).toBe(1);                         // over full scale stays at the top
    expect(logic.meterPos(-3)).toBeCloseTo(1 - 1 / M.length, 6);   // marks evenly spaced
    expect(logic.meterPos(-27)).toBeCloseTo(1 - 8 / M.length, 6);
    expect(logic.meterPos(-60)).toBeCloseTo(1 / M.length, 6);
    expect(logic.meterPosition(0.5)).toBeCloseTo(logic.meterPos(20 * Math.log10(0.5)), 9);
    for (const d of [-0.5, -4.5, -20, -40, -59, -70]) expect(logic.meterDb(logic.meterPos(d))).toBeCloseTo(d, 6);
    expect(logic.meterDb(0)).toBe(-Infinity);
    expect(logic.formatDb(logic.levelDb(1))).toBe('0.0');
    expect(logic.formatDb(logic.levelDb(0.5))).toBe('−6.0');
    expect(logic.formatDb(logic.levelDb(0))).toBe('−∞');
    expect(logic.formatDb(3.04)).toBe('+3.0');
    expect(logic.meterGradient()).toContain('linear-gradient(to top');
  });

  it('opens the focused selected channel wide, and lets it be closed', async () => {
    const { engine, session, byName } = await connected();
    const shown = logic.channels(session);
    expect(logic.expandedId(session, shown)).toBe(null);
    await logic.select(session, byName('Gtr L'));
    await engine.settled();
    const id = byName('Gtr L').id;
    expect(logic.expandedId(session, shown)).toBe(id);
    expect(logic.expandedId(session, shown, id)).toBe(null);                              // closed here
    expect(logic.expandedId(session, shown.filter((c) => c.id !== id))).toBe(null);       // filtered out
  });

  it('lists loaded inserts and routed sends for the wide strip', async () => {
    const { engine, luna, session, byName } = await connected();
    engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176', categories: ['Compressor'] });
    engine.addPlugin('uaudio_luna_channel', { name: 'LUNA Channel', categories: ['Channel Strip'] });
    await engine.settled();
    await luna.plugins.load();
    const vox = byName('Lead Vox');
    await vox.effects.load();
    expect(logic.inserts(vox)).toEqual([]);
    const before = logic.wideKey(vox);
    await vox.insert('com.uaudio.uadx.1176');
    await engine.settled(); await luna.settled();
    const ins = logic.inserts(vox, (id) => luna.plugins.byId(id)?.name.value);
    expect(ins.map((r) => r.name)).toEqual(['UA 1176']);
    // A plugin in the console slot (where LUNA Channel lives) is listed first, marked as such.
    const consoleSlot = await vox.insert('uaudio_luna_channel', 'console');
    await engine.settled(); await luna.settled();
    expect(consoleSlot.id).toBe('console');
    const rows = logic.inserts(vox, (id) => luna.plugins.byId(id)?.name.value);
    expect(rows.map((r) => [r.name, r.place])).toEqual([['LUNA Channel', 'console'], ['UA 1176', null]]);
    // The same plugin in an insert too: only the console one is listed; tape is never listed.
    await vox.insert('uaudio_luna_channel');
    engine.addPlugin('uaudio_studer', { name: 'Studer A800', categories: ['Tape'] });
    await engine.settled(); await luna.settled();
    const rows2 = logic.inserts(vox, (id) => luna.plugins.byId(id)?.name.value);
    expect(rows2.map((r) => [r.name, r.place])).toEqual([['LUNA Channel', 'console'], ['UA 1176', null]]);
    expect(logic.SHOWN_SLOT_RE.test('tape')).toBe(false);
    expect(logic.sameName('LUNA Channel', 'luna  channel')).toBe(true);
    expect(logic.wideKey(vox)).not.toBe(before);

    await vox.outputs.load();
    expect(logic.sends(vox)).toEqual([]);
    const reverb = byName('Reverb');
    const send = vox.outputs.byId('send_0');
    await send.controls.load();
    await send.retarget(reverb.id);
    await engine.settled(); await luna.settled();
    expect(logic.sends(vox).map((r) => r.to)).toEqual(['Reverb']);
  });

  it('reads EQ bands from parameter names and draws their response', () => {
    const P = (id, real, display = String(real)) => ({ id, name: { value: 'parameter' }, real: { value: real }, display: { value: display } });
    const params = [
      P('eq_b1_freq', 80, '80 Hz'), P('eq_b1_gain', 3),
      P('eq_b2_freq', 400, '400 Hz'), P('eq_b2_gain', -4), P('eq_b2_q', 2),
      P('eq_b3_freq', 3000), P('eq_b3_gain', 0), P('eq_b3_q', 1),
      P('eq_b4_freq', 10000), P('eq_b4_gain', 2.5),
      P('hpf_freq', 60), P('output_gain', 6), P('bypass', 0),
    ];
    const bands = logic.eqBands(params);
    const by = (t) => bands.filter((b) => b.type === t);
    expect(by('lowshelf')).toEqual([{ type: 'lowshelf', freq: 80, gain: 3, q: 0.7 }]);
    expect(by('bell')).toEqual([{ type: 'bell', freq: 400, gain: -4, q: 2 }, { type: 'bell', freq: 3000, gain: 0, q: 1 }]);   // a flat band stays, to drag
    expect(by('highshelf').map((b) => b.freq)).toEqual([10000]);
    expect(by('hpf').map((b) => b.freq)).toEqual([60]);
    const bell = { type: 'bell', freq: 1000, gain: 6, q: 1 };
    expect(logic.bandDb(bell, 1000)).toBeCloseTo(6, 1);
    expect(Math.abs(logic.bandDb(bell, 20))).toBeLessThan(0.1);
    expect(logic.bandDb({ type: 'hpf', freq: 100, gain: 0, q: 0.7 }, 20)).toBeLessThan(-20);
    const f = logic.logFreqs(5);
    expect(f[0]).toBeCloseTo(20); expect(f[4]).toBeCloseTo(20000);
    expect(logic.eqResponse([], f)).toEqual([0, 0, 0, 0, 0]);
    expect(logic.eqBands([P('drive', 3), P('ratio', 4)])).toEqual([]);
    expect(logic.eqParams([...params, P('drive', 3), P('ratio', 4)]).map((p) => p.id)).toEqual(
      ['eq_b1_freq', 'eq_b1_gain', 'eq_b2_freq', 'eq_b2_gain', 'eq_b2_q', 'eq_b3_freq', 'eq_b3_gain', 'eq_b3_q', 'eq_b4_freq', 'eq_b4_gain', 'hpf_freq']);
  });

  it('moves a channel left and right in LUNA, within its folder, past what is shown', async () => {
    const { engine, luna, session, byName } = await connected();
    const order = () => logic.channels(session).filter((c) => logic.movable(c)).map((c) => c.name.value);
    expect(order()).toEqual(['Lead Vox', 'BG Vox', 'Gtr L', 'Gtr R', 'Keys', 'Reverb']);
    expect(await logic.move(session, byName('Gtr L'), -1)).toBe(true);
    await engine.settled(); await luna.settled();
    expect(order()).toEqual(['Lead Vox', 'Gtr L', 'BG Vox', 'Gtr R', 'Keys', 'Reverb']);
    await logic.move(session, byName('Gtr L'), -1);
    await engine.settled(); await luna.settled();
    expect(order()[0]).toBe('Gtr L');
    expect(await logic.move(session, byName('Gtr L'), -1)).toBe(false);          // already first
    await logic.move(session, byName('Lead Vox'), 1);
    await engine.settled(); await luna.settled();
    expect(order()).toEqual(['Gtr L', 'BG Vox', 'Lead Vox', 'Gtr R', 'Keys', 'Reverb']);
    expect(await logic.move(session, byName('Reverb'), 1)).toBe(false);          // already last
    // With a filter, it steps past the next shown channel (Keys), skipping hidden ones.
    const shown = new Set([byName('Lead Vox').id, byName('Keys').id]);
    await logic.move(session, byName('Lead Vox'), 1, shown);
    await engine.settled(); await luna.settled();
    expect(order()).toEqual(['Gtr L', 'BG Vox', 'Gtr R', 'Keys', 'Lead Vox', 'Reverb']);
    // Inside a folder it moves among the folder's contents only.
    const drums = await session.newFolder({ name: 'Gtrs' });
    await session.moveToFolder([byName('Gtr L'), byName('Gtr R')], drums);
    await engine.settled(); await luna.settled();
    expect(logic.moveTarget(session, byName('Gtr L'), -1)).toBe(null);
    await logic.move(session, byName('Gtr L'), 1);
    await engine.settled(); await luna.settled();
    const inFolder = logic.channels(session).filter((c) => c.folderUid.value === drums.id).map((c) => c.name.value);
    expect(inFolder).toEqual(['Gtr R', 'Gtr L']);
    expect(logic.movable(logic.channels(session).at(-1))).toBe(false);          // the master
  });
});

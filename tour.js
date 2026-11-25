// A short guided tour, shared by Fede Trillo's Add Ons: each step lights up one part of the
// window with a bubble that explains it. Shown the first time an Add On opens, and again from
// the "?" button. Self-contained: it brings its own styles.

(function (root) {
  const css = `
  .tour-veil { position: fixed; inset: 0; z-index: 90; }
  .tour-hole { position: fixed; z-index: 91; border-radius: 12px; box-shadow: 0 0 0 9999px rgba(0,0,0,.62); outline: 2px solid var(--acc, var(--accent, var(--slow, #8ab4ff))); outline-offset: 3px; transition: all .22s ease; pointer-events: none; }
  .tour-tip { position: fixed; z-index: 92; width: 300px; background: var(--panel2, var(--raised, var(--panel))); color: var(--text); border: 1px solid var(--edge, var(--line, #3a3d44)); border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.55); padding: 14px 16px 12px; transition: top .22s ease, left .22s ease; }
  .tour-tip h4 { margin: 0 0 6px; font-size: 14px; }
  .tour-tip p { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--silk); }
  .tour-tip .tour-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .tour-tip .tour-dots { flex: 1; display: flex; gap: 5px; }
  .tour-tip .tour-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--edge, var(--line, #3a3d44)); }
  .tour-tip .tour-dots i.on { background: var(--acc, var(--accent, var(--slow, #8ab4ff))); }
  .tour-tip button { border: 1px solid var(--edge, var(--line, #3a3d44)); background: var(--well); color: var(--text); border-radius: 9px; padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; }
  .tour-tip button.tour-next { border: 0; color: var(--ink); background: linear-gradient(90deg, var(--acc, var(--accent, var(--slow, #8ab4ff))), var(--acc2, var(--acc, var(--accent, var(--slow, #8ab4ff))))); }
  .tour-tip button.tour-skip { border: 0; background: none; color: var(--dim); padding: 6px 4px; }
  .tour-langs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-top: 12px; }
  .tour-tip .tour-langs button { text-align: left; padding: 8px 10px; font-size: 12.5px; }
  .tour-tip .tour-langs button.on { border-color: var(--acc, var(--accent, var(--slow, #8ab4ff))); background: color-mix(in srgb, var(--acc, var(--accent, var(--slow, #8ab4ff))) 16%, var(--well)); }
  .tour-help { min-width: 28px; height: 28px; border-radius: 9px; border: 1px solid var(--edge, var(--line, #3a3d44)); background: var(--well); color: var(--dim); font-weight: 800; font-size: 12px; padding: 0 10px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
  .tour-help b { display: inline-grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; background: var(--edge, var(--line, #3a3d44)); color: var(--text); font-size: 10.5px; }
  .tour-help:hover { color: var(--text); border-color: var(--silk); }
  `;
  let styled = false;
  const ensureStyle = () => { if (styled) return; const s = document.createElement('style'); s.textContent = css; document.head.append(s); styled = true; };

  // steps: [{ sel, title, text }]; labels: { next, done, skip, back }; onEnd(): called once.
  function start(steps, labels, onEnd) {
    ensureStyle();
    stop();
    const veil = document.createElement('div'); veil.className = 'tour-veil';
    const hole = document.createElement('div'); hole.className = 'tour-hole';
    const tip = document.createElement('div'); tip.className = 'tour-tip'; tip.setAttribute('role', 'dialog');
    document.body.append(veil, hole, tip);
    let i = 0;
    const end = () => { stop(); onEnd?.(); };
    function place() {
      const st = steps[i];
      const target = document.querySelector(st.sel);
      const r = target ? target.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0, right: innerWidth / 2, bottom: innerHeight / 2 };
      const pad = 4;
      Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      tip.innerHTML = '';
      const h = document.createElement('h4'); h.textContent = typeof st.title === 'function' ? st.title() : st.title;
      const p = document.createElement('p'); p.textContent = typeof st.text === 'function' ? st.text() : st.text;
      const row = document.createElement('div'); row.className = 'tour-row';
      const dots = document.createElement('div'); dots.className = 'tour-dots';
      steps.forEach((_, k) => { const d = document.createElement('i'); if (k === i) d.className = 'on'; dots.append(d); });
      const skip = document.createElement('button'); skip.className = 'tour-skip'; skip.textContent = labels.skip; skip.onclick = end;
      const L = typeof labels === 'function' ? labels() : labels;
      skip.textContent = L.skip;
      const next = document.createElement('button'); next.className = 'tour-next'; next.textContent = i === steps.length - 1 ? L.done : L.next;
      next.onclick = () => { if (i < steps.length - 1) { i++; place(); } else end(); };
      row.append(dots);
      if (i < steps.length - 1 && !st.noSkip) row.append(skip);
      if (i > 0 && !steps[i - 1].once) { const back = document.createElement('button'); back.textContent = L.back; back.onclick = () => { i--; place(); }; row.append(back); }
      row.append(next);
      tip.append(h, p);
      st.extra?.(tip, place);
      tip.append(row);
      // Below the target if it fits, else above, else beside; always inside the window.
      const tw = tip.offsetWidth, th = tip.offsetHeight, m = 12;
      let top = r.bottom + m, left = r.left + r.width / 2 - tw / 2;
      if (top + th > innerHeight - 8) top = r.top - th - m;
      if (top < 8) { top = Math.max(8, Math.min(innerHeight - th - 8, r.top + r.height / 2 - th / 2)); left = r.right + m + tw < innerWidth ? r.right + m : r.left - tw - m; }
      tip.style.left = `${Math.max(8, Math.min(innerWidth - tw - 8, left))}px`;
      tip.style.top = `${Math.max(8, top)}px`;
      (tip.querySelector('.tour-langs .on') ?? next).focus();
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!steps[i].noSkip) end(); } else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); tip.querySelector('.tour-next')?.click(); } else if (e.key === 'ArrowLeft' && i > 0 && !steps[i - 1].once) { i--; place(); } };
    const onResize = () => place();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    veil.onclick = () => undefined;
    current = { veil, hole, tip, onKey, onResize };
    place();
  }
  let current = null;
  function stop() {
    if (!current) return;
    current.veil.remove(); current.hole.remove(); current.tip.remove();
    document.removeEventListener('keydown', current.onKey, true);
    window.removeEventListener('resize', current.onResize);
    current = null;
  }
  // A "?" button that starts the tour; `key` remembers in localStorage that it has been seen.
  // `language` ({ sel, list, current, set, title, text }) makes the first run open with a language
  // choice, so the guide that follows is already in that language. It cannot be skipped.
  function attach({ button, key, steps, labels, auto = true, language = null }) {
    ensureStyle();
    button.classList.add('tour-help');
    const finish = () => { try { localStorage.setItem(key, '1'); } catch { /* not fatal */ } };
    const run = (withLanguage = false) => {
      const list = steps();
      if (withLanguage && language) {
        list.unshift({
          sel: language.sel, noSkip: true, once: true,
          title: () => language.title(), text: () => language.text(),
          extra: (tip, repaint) => {
            const box = document.createElement('div'); box.className = 'tour-langs';
            for (const [code, name] of language.list()) {
              const b = document.createElement('button'); b.textContent = name; b.lang = code;
              if (code === language.current()) b.className = 'on';
              b.onclick = () => { language.set(code); repaint(); };
              box.append(b);
            }
            tip.append(box);
          },
        });
      }
      start(list, labels, finish);
    };
    button.onclick = () => run(false);
    let seen = false;
    try { seen = localStorage.getItem(key) === '1'; } catch { /* not fatal */ }
    if (auto && !seen) setTimeout(() => run(true), 600);
    return { run, get active() { return !!current; } };
  }

  root.AddOnTour = { start, stop, attach };
})(typeof window !== 'undefined' ? window : globalThis);

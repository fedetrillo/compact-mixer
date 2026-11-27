// Copies a report to the clipboard. Some LUNA webviews (seen on Windows) refuse
// navigator.clipboard, so this falls back to execCommand and, as a last resort,
// shows the text selected in a small box so it can be copied by hand.
// AddOnCopy(text) resolves to true when it reached the clipboard, false when the box is shown.
(() => {
  function legacy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }
  function box(text) {
    document.getElementById('addonCopyBox')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'addonCopyBox';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    const card = document.createElement('div');
    card.style.cssText = 'background:#1c1d21;color:#eee;border:1px solid #444;border-radius:8px;padding:12px;width:min(520px,100%);display:flex;flex-direction:column;gap:8px;font:12px system-ui,sans-serif';
    const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const head = document.createElement('div'); head.textContent = `${mac ? '⌘' : 'Ctrl'}+C`;
    head.style.cssText = 'font-weight:600';
    const ta = document.createElement('textarea'); ta.value = text; ta.readOnly = true;
    ta.style.cssText = 'width:100%;height:160px;resize:none;background:#111;color:#ddd;border:1px solid #333;border-radius:4px;font:11px ui-monospace,monospace;padding:6px;box-sizing:border-box';
    const ok = document.createElement('button'); ok.textContent = 'OK';
    ok.style.cssText = 'align-self:flex-end;padding:4px 14px;border-radius:4px;border:1px solid #555;background:#2a2b30;color:#eee;cursor:pointer';
    const close = () => wrap.remove();
    ok.onclick = close; wrap.onclick = (e) => { if (e.target === wrap) close(); };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') setTimeout(close, 150); });
    card.append(head, ta, ok); wrap.append(card); document.body.append(wrap);
    ta.focus(); ta.select();
  }
  window.AddOnCopy = async (text) => {
    text = String(text);
    try { await navigator.clipboard.writeText(text); return true; } catch { /* try the old way */ }
    if (legacy(text)) return true;
    box(text); return false;
  };
})();

// Fits the page to the part of the window you can see.
// On Windows, LUNA sizes the page to the window's outer size, title bar and frame included,
// so the last 39 px and the right 16 px fall outside the visible area (measured on a
// customer's machine: page 900 x 701, visible 884 x 662; confirmed fixed with this inset).
// Also covers the case where LUNA lays the page out taller than the size it reports.
(() => {
  const WIN = /^Win/i.test(navigator.platform || '');
  const INSET_W = WIN ? 16 : 0, INSET_H = WIN ? 39 : 0;
  let info = null;
  function apply(me) {
    const fit = () => {
      const h = Number(me?.height?.value) || 0, inner = window.innerHeight, innerW = window.innerWidth;
      const useH = (h > 0 && inner - h > 4 ? Math.min(h, inner) : inner) - INSET_H;
      const useW = innerW - INSET_W;
      const fitted = useH < inner || useW < innerW;
      for (const s of [document.documentElement.style, document.body.style]) {
        s.height = fitted ? `${useH}px` : '';
        s.width = useW < innerW ? `${useW}px` : '';
      }
      document.documentElement.style.overflow = fitted ? 'auto' : '';
      info = { lunaW: Number(me?.width?.value) || null, lunaH: h || null, innerW, innerH: inner, outerW: window.outerWidth, outerH: window.outerHeight, dpr: window.devicePixelRatio, fitted: fitted ? `${useW}x${useH}` : null, platform: navigator.platform };
    };
    fit(); me?.height?.onChange?.(fit); me?.width?.onChange?.(fit); window.addEventListener('resize', fit);
  }
  let tries = 0;
  async function start() {
    const client = window.Luna?.clients?.()?.[0];
    if (!client) { tries++; setTimeout(start, tries < 120 ? 500 : 3000); return; }
    let me = null;
    try { me = await client.gui.thisInstance(); } catch { me = null; }
    if ((me?.target?.value ?? 'window') === 'window') apply(me);
  }
  window.AddOnWinFit = { info: () => info, inset: { w: INSET_W, h: INSET_H } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

'use strict';
// Start screen motion graphic (original): a curved LED volume lights up tile by tile,
// a tracked camera draws its frustum, and the inner frustum sweeps across the wall.
(function () {
  const svg = document.getElementById('splash');
  if (!svg) return;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(e);
    return e;
  };
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Curved wall: columns on an arc, seen from slightly above
  const COLS = 14, ROWS = 5, cx = 300, cy = 300, R = 330, a0 = -0.62, a1 = 0.62;
  const top = 34, rowH = 26;
  const colX = i => { const a = a0 + (a1 - a0) * i / COLS; return { x: cx + R * Math.sin(a), d: Math.cos(a) }; };
  const tiles = [];
  const wall = mk('g', {});
  for (let i = 0; i < COLS; i++) {
    const L = colX(i), Rr = colX(i + 1);
    for (let j = 0; j < ROWS; j++) {
      // edges sag toward the viewer slightly to read as curved
      const sagL = (1 - L.d) * 110, sagR = (1 - Rr.d) * 110;
      const yT1 = top + j * rowH + sagL * 0.3, yT2 = top + j * rowH + sagR * 0.3;
      const yB1 = yT1 + rowH - 3, yB2 = yT2 + rowH - 3;
      const pts = `${L.x + 1.5},${yT1} ${Rr.x - 1.5},${yT2} ${Rr.x - 1.5},${yB2} ${L.x + 1.5},${yB1}`;
      const p = mk('polygon', { points: pts, fill: '#fff', 'fill-opacity': 0, stroke: '#fff', 'stroke-opacity': 0, 'stroke-width': 0.8 }, wall);
      tiles.push({ el: p, i, j, cxp: (L.x + Rr.x) / 2, born: 0.08 + (i + j * 0.6) * 0.045, base: 0.05 + 0.06 * Math.random() });
    }
  }
  // Floor line and camera
  mk('line', { x1: 40, y1: 318, x2: 560, y2: 318, stroke: '#fff', 'stroke-opacity': 0.12, 'stroke-width': 1 });
  const cam = { x: 300, y: 300 };
  const camG = mk('g', { opacity: 0 });
  mk('rect', { x: cam.x - 11, y: cam.y - 7, width: 22, height: 14, fill: '#000', stroke: '#fff', 'stroke-width': 1.2 }, camG);
  mk('circle', { cx: cam.x, cy: cam.y - 13, r: 4, fill: 'none', stroke: '#fff', 'stroke-width': 1 }, camG);
  const fr1 = mk('line', { stroke: '#fff', 'stroke-opacity': 0.55, 'stroke-width': 1 });
  const fr2 = mk('line', { stroke: '#fff', 'stroke-opacity': 0.55, 'stroke-width': 1 });
  const frFill = mk('polygon', { fill: '#fff', 'fill-opacity': 0.04 });

  const ease = x => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));
  const t0 = performance.now();
  function frame(now) {
    const t = reduce ? 4 : (now - t0) / 1000;
    // inner frustum centre sweeps across the wall
    const sweep = 300 + Math.sin(t * 0.55) * 150;
    const halfW = 62;
    for (const k of tiles) {
      const on = ease((t - k.born) / 0.5);
      // inner frustum: a lit rectangle with a soft edge
      const dist = Math.abs(k.cxp - sweep);
      const inFr = dist <= halfW - 18 ? 1 : dist >= halfW + 6 ? 0 : 1 - (dist - (halfW - 18)) / 24;
      const flick = reduce ? 0 : 0.03 * Math.sin(t * 3 + k.i * 1.7 + k.j * 2.3);
      k.el.setAttribute('fill-opacity', (on * (k.base + flick + inFr * 0.55)).toFixed(3));
      k.el.setAttribute('stroke-opacity', (on * (0.22 + inFr * 0.5)).toFixed(3));
    }
    const camOn = ease((t - 0.7) / 0.5);
    camG.setAttribute('opacity', camOn.toFixed(3));
    // frustum draws out from the camera to the wall
    const reach = ease((t - 0.9) / 0.7);
    // land on the lower edge of the wall, where it meets the lit region
    const sagAt = x => { const a = Math.asin(Math.max(-1, Math.min(1, (x - cx) / R))); return (1 - Math.cos(a)) * 110 * 0.3; };
    const lx = sweep - halfW, rx = sweep + halfW;
    const yB = x => top + ROWS * rowH - 3 + sagAt(x);
    const ex1 = cam.x + (lx - cam.x) * reach, ey1 = cam.y - 7 + (yB(lx) - cam.y + 7) * reach;
    const ex2 = cam.x + (rx - cam.x) * reach, ey2 = cam.y - 7 + (yB(rx) - cam.y + 7) * reach;
    fr1.setAttribute('x1', cam.x); fr1.setAttribute('y1', cam.y - 7); fr1.setAttribute('x2', ex1); fr1.setAttribute('y2', ey1);
    fr2.setAttribute('x1', cam.x); fr2.setAttribute('y1', cam.y - 7); fr2.setAttribute('x2', ex2); fr2.setAttribute('y2', ey2);
    frFill.setAttribute('points', `${cam.x},${cam.y - 7} ${ex1},${ey1} ${ex2},${ey2}`);
    fr1.setAttribute('stroke-opacity', (0.55 * camOn).toFixed(3));
    fr2.setAttribute('stroke-opacity', (0.55 * camOn).toFixed(3));
    if (!reduce && !document.getElementById('auth').hidden) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // restart when the start screen is shown again (e.g. wrong PIN after reconnect)
  new MutationObserver(() => { if (!document.getElementById('auth').hidden && !reduce) requestAnimationFrame(frame); })
    .observe(document.getElementById('auth'), { attributes: true, attributeFilter: ['hidden'] });
  const host = document.getElementById('authHost');
  if (host) host.textContent = location.host;
})();

/* =============================================================
   Beams Background — plain Canvas 2D (no Three.js needed)
   Ported from the BeamsBackground React component.
   Creates a fixed <canvas id="bg-shader"> prepended to <body>.
   ============================================================= */
(function () {
  'use strict';

  var canvas = document.createElement('canvas');
  canvas.id = 'bg-shader';
  document.body.prepend(canvas);

  var ctx    = canvas.getContext('2d');
  var W = 0, H = 0, DPR = 1;
  var beams  = [];
  var BEAM_COUNT = 30;

  /* ── beam factory ───────────────────────────────────────────── */
  function createBeam() {
    return {
      x:          Math.random() * W * 1.5 - W * 0.25,
      y:          Math.random() * H * 1.5 - H * 0.25,
      w:          30  + Math.random() * 60,
      len:        H   * 2.5,
      angle:      -35 + Math.random() * 10,
      speed:      0.6 + Math.random() * 1.2,
      opacity:    0.12 + Math.random() * 0.16,
      hue:        190 + Math.random() * 70,   /* cyan → blue-violet */
      pulse:      Math.random() * Math.PI * 2,
      pulseSpeed: 0.02 + Math.random() * 0.03
    };
  }

  function resetBeam(b, idx) {
    var col     = idx % 3;
    var spacing = W / 3;
    b.y       = H + 100;
    b.x       = col * spacing + spacing / 2 + (Math.random() - 0.5) * spacing * 0.5;
    b.w       = 100 + Math.random() * 100;
    b.speed   = 0.5 + Math.random() * 0.4;
    b.hue     = 190 + (idx * 70) / BEAM_COUNT;
    b.opacity = 0.2  + Math.random() * 0.1;
  }

  /* ── draw one beam ──────────────────────────────────────────── */
  function drawBeam(b) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle * Math.PI / 180);

    var op = b.opacity * (0.8 + Math.sin(b.pulse) * 0.2);
    var h  = b.hue;

    var g = ctx.createLinearGradient(0, 0, 0, b.len);
    g.addColorStop(0,   'hsla(' + h + ',85%,65%,0)');
    g.addColorStop(0.1, 'hsla(' + h + ',85%,65%,' + (op * 0.5) + ')');
    g.addColorStop(0.4, 'hsla(' + h + ',85%,65%,' + op + ')');
    g.addColorStop(0.6, 'hsla(' + h + ',85%,65%,' + op + ')');
    g.addColorStop(0.9, 'hsla(' + h + ',85%,65%,' + (op * 0.5) + ')');
    g.addColorStop(1,   'hsla(' + h + ',85%,65%,0)');

    ctx.fillStyle = g;
    ctx.fillRect(-b.w / 2, 0, b.w, b.len);
    ctx.restore();
  }

  /* ── resize / init beams ────────────────────────────────────── */
  function resize() {
    DPR = window.devicePixelRatio || 1;
    W   = window.innerWidth;
    H   = window.innerHeight;

    canvas.width  = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(DPR, DPR);

    beams = [];
    for (var i = 0; i < BEAM_COUNT; i++) beams.push(createBeam());
  }

  /* ── animation loop ─────────────────────────────────────────── */
  function tick() {
    /* solid dark base */
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, W, H);

    /* blurred beams layer */
    ctx.save();
    ctx.filter = 'blur(32px)';
    for (var i = 0; i < beams.length; i++) {
      var b = beams[i];
      b.y     -= b.speed;
      b.pulse += b.pulseSpeed;
      if (b.y + b.len < -100) resetBeam(b, i);
      drawBeam(b);
    }
    ctx.restore();

    /* radial vignette — pull edges to near-black */
    var vig = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    vig.addColorStop(0,   'rgba(9,9,11,0)');
    vig.addColorStop(0.6, 'rgba(9,9,11,0.1)');
    vig.addColorStop(1,   'rgba(9,9,11,0.72)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);

    requestAnimationFrame(tick);
  }

  /* ── boot ───────────────────────────────────────────────────── */
  function init() {
    resize();
    window.addEventListener('resize', resize);
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

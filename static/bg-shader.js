/* =============================================================
   WebGL animated sine-wave background shader
   Uses Three.js (loaded via CDN before this script)
   Creates and prepends a fixed <canvas id="bg-shader"> to body.
   ============================================================= */
(function () {
  'use strict';

  function initShader() {
    if (typeof THREE === 'undefined') {
      console.warn('bg-shader: THREE not loaded');
      return;
    }

    /* ── Canvas ── */
    var canvas = document.createElement('canvas');
    canvas.id = 'bg-shader';
    document.body.prepend(canvas);

    /* ── Renderer ── */
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000);

    /* ── Camera (full-screen quad) ── */
    var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);
    var scene  = new THREE.Scene();

    /* ── Shaders ── */
    var vertexShader = [
      'attribute vec3 position;',
      'void main() {',
      '  gl_Position = vec4(position, 1.0);',
      '}'
    ].join('\n');

    var fragmentShader = [
      'precision highp float;',
      'uniform vec2  resolution;',
      'uniform float time;',
      'uniform float xScale;',
      'uniform float yScale;',
      'uniform float distortion;',
      '',
      'void main() {',
      '  vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);',
      '',
      '  float d  = length(p) * distortion;',
      '',
      '  float rx = p.x * (1.0 + d);',
      '  float gx = p.x;',
      '  float bx = p.x * (1.0 - d);',
      '',
      '  float r = 0.05 / abs(p.y + sin((rx + time) * xScale) * yScale);',
      '  float g = 0.05 / abs(p.y + sin((gx + time) * xScale) * yScale);',
      '  float b = 0.05 / abs(p.y + sin((bx + time) * xScale) * yScale);',
      '',
      '  gl_FragColor = vec4(r, g, b, 1.0);',
      '}'
    ].join('\n');

    /* ── Uniforms ── */
    var uniforms = {
      resolution: { value: [window.innerWidth, window.innerHeight] },
      time:       { value: 0.0 },
      xScale:     { value: 1.0 },
      yScale:     { value: 0.5 },
      distortion: { value: 0.05 }
    };

    /* ── Full-screen quad geometry ── */
    var verts = new Float32Array([
      -1, -1, 0,   1, -1, 0,  -1, 1, 0,
       1, -1, 0,  -1,  1, 0,   1, 1, 0
    ]);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));

    var mat = new THREE.RawShaderMaterial({
      vertexShader:  vertexShader,
      fragmentShader: fragmentShader,
      uniforms:      uniforms,
      side:          THREE.DoubleSide
    });

    scene.add(new THREE.Mesh(geo, mat));

    /* ── Resize handler ── */
    function resize() {
      var w = window.innerWidth;
      var h = window.innerHeight;
      renderer.setSize(w, h, false);
      uniforms.resolution.value = [w, h];
    }
    resize();
    window.addEventListener('resize', resize);

    /* ── Animation loop ── */
    function tick() {
      uniforms.time.value += 0.01;
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    }
    tick();
  }

  /* Run after DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShader);
  } else {
    initShader();
  }
})();

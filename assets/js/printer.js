(() => {
  const canvas = document.getElementById("printerCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("printerStatus");
  const pauseBtn = document.getElementById("printerPause");
  const speedBtn = document.getElementById("printerSpeed");

  // Timeline (seconds): print -> power on & turn -> walk off -> gantry reset
  const T = { print: 16, boot: 2, walk: 10, reset: 2 };
  const TOTAL = T.print + T.boot + T.walk + T.reset;

  const B = 6; // bed half-size
  const H = 8; // robot height
  const FLOOR_Z = -0.6;
  const PLINTH_Z = -2.2;
  const POST_H = 15;
  const ARM_Z = 13.4;
  const STRIDE = 4.2;
  const WALK_TH = (-22 * Math.PI) / 180;
  const HUES = [172, 200, 265, 38, 335];
  const C30 = Math.cos(Math.PI / 6);
  const S30 = 0.5;

  const BODY = [196, 210, 224];
  const DARK = [72, 84, 100];
  const OFF = [50, 58, 70];

  // f = forward, s = side, z = base height, w/d = extents (forward/side), h = height
  const PARTS = [
    { f: 0.25, s: 0.9, w: 1.5, d: 1.0, z: 0, h: 0.5, c: "dark", limb: "legL" },
    { f: 0.25, s: -0.9, w: 1.5, d: 1.0, z: 0, h: 0.5, c: "dark", limb: "legR" },
    { f: 0, s: 0.9, w: 0.7, d: 0.7, z: 0.5, h: 1.5, c: "body", limb: "legL" },
    { f: 0, s: -0.9, w: 0.7, d: 0.7, z: 0.5, h: 1.5, c: "body", limb: "legR" },
    { f: 0, s: 0, w: 2.2, d: 3.0, z: 2.0, h: 2.6, c: "body" },
    { f: 1.225, s: 0, w: 0.25, d: 1.6, z: 2.9, h: 1.0, c: "glow" },
    { f: 0, s: 1.85, w: 0.7, d: 0.7, z: 2.3, h: 2.0, c: "body", limb: "armL" },
    { f: 0, s: -1.85, w: 0.7, d: 0.7, z: 2.3, h: 2.0, c: "body", limb: "armR" },
    { f: 0, s: 0, w: 0.7, d: 0.7, z: 4.6, h: 0.4, c: "dark" },
    { f: 0, s: 0, w: 2.0, d: 2.4, z: 5.0, h: 1.6, c: "body" },
    { f: 1.125, s: 0, w: 0.25, d: 1.9, z: 5.4, h: 0.7, c: "glow" },
    { f: -0.3, s: 0, w: 0.2, d: 0.2, z: 6.6, h: 1.0, c: "dark" },
    { f: -0.3, s: 0, w: 0.5, d: 0.5, z: 7.6, h: 0.4, c: "glow" },
  ];

  let W, Hpx, S, ox, oy;
  let t = 0;
  let unit = 1;
  let paused = false;
  let speed = 1;
  let hopT = -1;
  let accent = hsl(HUES[0]);
  let nx = 0, ny = 0.9, nz = 0.5;
  let last = performance.now();
  let lastStatus = "";

  function hsl(h) {
    const s = 0.8, l = 0.6;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  const rgb = (c, k = 1) =>
    `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`;
  const sm = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    Hpx = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(Hpx * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S = Math.min(Hpx / 33, W / 26);
    ox = W > 700 ? W * 0.36 : W / 2;
    oy = (Hpx - 31.5 * S) / 2 + 21.6 * S;
  }

  const P = (x, y, z) => [ox + (x - y) * C30 * S, oy + (x + y) * S30 * S - z * S];

  function poly(pts, fill, stroke) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  function cuboid(cx, cy, w, d, th, z0, h, col, topCol, layers) {
    if (h <= 0.001) return;
    const co = Math.cos(th), si = Math.sin(th);
    const sg = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const c = sg.map(([a, b]) => {
      const lx = (a * w) / 2, ly = (b * d) / 2;
      return [cx + lx * co - ly * si, cy + lx * si + ly * co];
    });
    const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const z1 = z0 + h;
    for (let i = 0; i < 4; i++) {
      const [ln, lm] = normals[i];
      const nxw = ln * co - lm * si, nyw = ln * si + lm * co;
      if (nxw + nyw <= 0.001) continue;
      const a = c[i], b = c[(i + 1) % 4];
      const shade = 0.5 + 0.28 * nxw + 0.1 * nyw;
      poly(
        [P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1)],
        rgb(col, shade),
        "rgba(0,0,0,0.25)"
      );
      if (layers) {
        ctx.strokeStyle = "rgba(0,0,0,0.13)";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let zl = z0 + 0.3; zl < z1 - 0.01; zl += 0.3) {
          const p = P(a[0], a[1], zl), q = P(b[0], b[1], zl);
          ctx.moveTo(p[0], p[1]);
          ctx.lineTo(q[0], q[1]);
        }
        ctx.stroke();
      }
    }
    poly(c.map((p) => P(p[0], p[1], z1)), rgb(topCol || col, 1.05), "rgba(0,0,0,0.25)");
  }

  function pose() {
    const p = { printZ: 0, alive: false, awake: false, gone: false, printing: false,
      th: 0, px: 0, py: 0, amp: 0, phi: 0 };
    if (t < T.print) {
      p.printing = true;
      p.printZ = (H * t) / T.print;
    } else if (t < T.print + T.boot) {
      const u = (t - T.print) / T.boot;
      p.printZ = H;
      p.alive = true;
      p.awake = u > 0.2 && (u > 0.32 || Math.sin(u * 90) > 0);
      p.th = WALK_TH * sm((u - 0.35) / 0.65);
    } else if (t < T.print + T.boot + T.walk) {
      const u = (t - T.print - T.boot) / T.walk;
      const a = 0.08;
      const v = (u < a ? (u * u) / (2 * a) : u - a / 2) / (1 - a / 2);
      const perUnit = (Math.cos(WALK_TH) - Math.sin(WALK_TH)) * C30 * S;
      const L = ((W + 6 * S - ox) / perUnit) * v;
      p.printZ = H;
      p.alive = true;
      p.awake = true;
      p.th = WALK_TH;
      p.px = L * Math.cos(WALK_TH);
      p.py = L * Math.sin(WALK_TH);
      p.phi = (L / STRIDE) * Math.PI * 2;
      p.amp = Math.min(1, u / a);
    } else {
      p.gone = true;
    }
    return p;
  }

  function update(dt) {
    const k = (r) => 1 - Math.exp(-dt * r);
    let tx, ty, tz, r;
    if (t < T.print) {
      const pz = (H * t) / T.print;
      let act = PARTS.filter((q) => pz >= q.z - 0.001 && pz < q.z + q.h);
      if (!act.length) act = [PARTS[0]];
      const i = Math.floor(t * 2.2) % act.length;
      const q = act[i];
      tx = q.f + Math.sin(t * 9 + i) * q.w * 0.4;
      ty = q.s + Math.sin(t * 13.3) * q.d * 0.4;
      tz = pz;
      r = 16;
    } else if (t < T.print + T.boot + T.walk) {
      tx = -B + 1; ty = -B + 1; tz = 11.5; r = 2.5;
    } else {
      tx = 0; ty = 0.9; tz = 0.5; r = 2.2;
    }
    nx += (tx - nx) * k(r);
    ny += (ty - ny) * k(r);
    nz = t < T.print ? tz : nz + (tz - nz) * k(r);
  }

  function drawPrinter() {
    // plinth, bed
    cuboid(0, 0, 2 * B + 1.4, 2 * B + 1.4, 0, PLINTH_Z, FLOOR_Z - PLINTH_Z, [34, 42, 54]);
    cuboid(0, 0, 2 * B, 2 * B, 0, FLOOR_Z, 0.6, [46, 60, 76], [26, 36, 48]);
    ctx.strokeStyle = rgb(accent, 1);
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const g = -B + (i * 2 * B) / 6;
      let a = P(g, -B, 0), b = P(g, B, 0);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      a = P(-B, g, 0); b = P(B, g, 0);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // posts + rail
    const px = -B - 0.6;
    cuboid(px, -B - 0.6, 0.7, 0.7, 0, PLINTH_Z, POST_H - PLINTH_Z, [58, 70, 88]);
    cuboid(px, B + 0.6, 0.7, 0.7, 0, PLINTH_Z, POST_H - PLINTH_Z, [58, 70, 88]);
    cuboid(px, 0, 0.7, 2 * B + 1.9, 0, POST_H - 0.9, 0.9, [70, 84, 104]);
  }

  function drawGantry(p) {
    cuboid(-B - 0.6, ny, 1.0, 1.0, 0, ARM_Z - 0.5, 1.7, [90, 104, 124]);
    cuboid(0.2, ny, 13.6, 0.6, 0, ARM_Z, 0.6, [84, 98, 118]);
    cuboid(nx, ny, 1.3, 1.3, 0, ARM_Z - 0.3, 1.2, [104, 118, 138]);
    const rodTop = ARM_Z - 0.3;
    const rodBot = nz + 1.4;
    if (rodTop > rodBot) cuboid(nx, ny, 0.3, 0.3, 0, rodBot, rodTop - rodBot, [120, 132, 150]);
    cuboid(nx, ny, 0.9, 0.9, 0, nz + 0.5, 0.9, [78, 90, 108]);
    const tip = p.printing ? [255, 140, 60] : [120, 130, 140];
    cuboid(nx, ny, 0.35, 0.35, 0, nz, 0.5, tip);
    if (p.printing) {
      const g = P(nx, ny, nz);
      const grad = ctx.createRadialGradient(g[0], g[1], 0, g[0], g[1], S * 1.6);
      grad.addColorStop(0, "rgba(255,150,70,0.55)");
      grad.addColorStop(1, "rgba(255,150,70,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(g[0] - S * 1.6, g[1] - S * 1.6, S * 3.2, S * 3.2);
    }
  }

  function drawRobot(p) {
    if (p.gone) return;
    const co = Math.cos(p.th), si = Math.sin(p.th);
    const hopZ = hopT >= 0 ? 2.6 * Math.sin((Math.PI * hopT) / 0.7) : 0;
    const bob = p.amp * 0.12 * Math.cos(2 * p.phi);

    if (p.alive) {
      const c = P(p.px, p.py, 0);
      ctx.fillStyle = `rgba(0,0,0,${0.3 * (1 - hopZ / 4)})`;
      ctx.beginPath();
      ctx.ellipse(c[0], c[1], 2.4 * S, 1.2 * S, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const items = PARTS.map((q) => {
      let f = q.f, z = q.z + bob + hopZ;
      if (q.limb) {
        const leg = q.limb.startsWith("leg");
        const side = q.limb.endsWith("L") ? 0 : Math.PI;
        const ph = p.phi + side;
        if (leg) {
          f += Math.sin(ph) * 1.1 * p.amp;
          z += Math.max(0, Math.cos(ph)) * 0.6 * p.amp;
        } else {
          f -= Math.sin(ph) * 0.9 * p.amp;
        }
      }
      const cx = p.px + f * co - q.s * si;
      const cy = p.py + f * si + q.s * co;
      return { q, cx, cy, z, key: cx + cy };
    });
    items.sort((a, b) => a.key - b.key || a.z - b.z);

    for (const it of items) {
      const q = it.q;
      const ph = p.printing ? Math.max(0, Math.min(q.h, p.printZ - q.z)) : q.h;
      if (ph <= 0.01) continue;
      let col = q.c === "body" ? BODY : DARK;
      let glow = false;
      if (q.c === "glow") {
        if (p.awake) { col = accent; glow = true; } else col = OFF;
      }
      const top = p.printing && ph < q.h ? mix(col, [255, 150, 70], 0.7) : col;
      if (glow) {
        ctx.shadowColor = rgb(accent);
        ctx.shadowBlur = 14;
      }
      cuboid(it.cx, it.cy, q.w, q.d, p.th, it.z, ph, col, top, true);
      ctx.shadowBlur = 0;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, Hpx);
    const p = pose();
    drawPrinter();
    drawRobot(p);
    drawGantry(p);
    setStatus(p);
  }

  function setStatus(p) {
    let s;
    const id = "UNIT " + String(unit).padStart(3, "0");
    if (paused) s = id + " · paused";
    else if (p.printing) s = id + " · printing " + Math.round((t / T.print) * 100) + "%";
    else if (t < T.print + T.boot) s = id + " · powering on";
    else if (!p.gone) s = id + " · walking off-plate";
    else s = "homing gantry";
    if (s !== lastStatus) {
      lastStatus = s;
      if (statusEl) statusEl.textContent = s;
    }
  }

  function newUnit() {
    unit++;
    accent = hsl(HUES[(unit - 1) % HUES.length]);
    hopT = -1;
  }

  function frame(now) {
    const rdt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!paused) {
      const dt = rdt * speed;
      t += dt;
      if (t >= TOTAL) {
        t -= TOTAL;
        newUnit();
      }
      update(dt);
      if (hopT >= 0) {
        hopT += dt;
        if (hopT > 0.7) hopT = -1;
      }
    }
    draw();
    requestAnimationFrame(frame);
  }

  canvas.addEventListener("click", () => {
    if (t >= T.print && t < T.print + T.boot + T.walk && hopT < 0) hopT = 0;
  });

  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Play" : "Pause";
    pauseBtn.setAttribute("aria-pressed", paused);
  });

  speedBtn.addEventListener("click", () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    speedBtn.textContent = speed + "×";
  });

  window.addEventListener("resize", resize);
  resize();

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    paused = true;
    t = T.print + T.boot * 0.95;
    nz = 11.5;
    pauseBtn.textContent = "Play";
  }

  requestAnimationFrame(frame);
})();

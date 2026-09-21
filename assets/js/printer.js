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
  const POST_H = 12.5;
  const ARM_Z = 11.2;
  const STRIDE = 3;
  // Room: floor at z=0, back wall along y=RY0 with an exit door at x=DOOR_X
  const RX0 = -8, RY0 = -11, RY1 = 8.5;
  const DOOR_X = 13, DOOR_W = 4.8, DOOR_H = 9.8;
  const WALL_H = 11.5, WT = 0.6;
  const RX1 = DOOR_X + 6;
  const L1 = DOOR_X, L2 = 17;
  const TURN = 0.8, RAMP = 0.7;
  const HUES = [172, 200, 265, 38, 335];
  const C30 = Math.cos(Math.PI / 6);
  const S30 = 0.5;
  const TOTAL_D = L1 + L2;
  const V0 = TOTAL_D / (T.walk - TURN - RAMP / 2);
  const TAU1 = L1 / V0 + RAMP / 2;

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
    S = Math.min(Hpx / 39, W / 43.5);
    const minX = (RX0 - RY1) * C30, maxX = (RX1 - RY0) * C30;
    const topY = (RX0 + RY0) * S30 - WALL_H, botY = (RX1 + RY1) * S30 + 1.2;
    ox = W / 2 - ((minX + maxX) / 2) * S;
    oy = Hpx / 2 - ((topY + botY) / 2) * S;
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
    } else if (t < T.print + T.boot + T.walk) {
      const w = t - T.print - T.boot;
      let tau = w, turn = 0;
      if (w >= TAU1 + TURN) { tau = w - TURN; turn = 1; }
      else if (w >= TAU1) { tau = TAU1; turn = (w - TAU1) / TURN; }
      const d = Math.min(TOTAL_D, tau < RAMP ? (V0 * tau * tau) / (2 * RAMP) : V0 * (tau - RAMP / 2));
      p.printZ = H;
      p.alive = true;
      p.awake = true;
      p.th = (-Math.PI / 2) * sm(turn);
      p.px = Math.min(d, L1);
      p.py = -Math.max(0, d - L1);
      p.phi = (d / STRIDE) * Math.PI * 2;
      p.amp = Math.min(1, tau / RAMP) * (turn > 0 && turn < 1 ? Math.abs(1 - 2 * turn) : 1);
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
      tx = -B + 1; ty = -B + 1; tz = 9.2; r = 2.5;
    } else {
      tx = 0; ty = 0.9; tz = 0.5; r = 2.2;
    }
    nx += (tx - nx) * k(r);
    ny += (ty - ny) * k(r);
    nz = t < T.print ? tz : nz + (tz - nz) * k(r);
  }

  const hw = DOOR_W / 2;

  function drawRoom() {
    // dark space behind the doorway
    const by = RY0 - WT - 0.05;
    const pq = [P(DOOR_X - hw - 0.4, by, -0.6), P(DOOR_X + hw + 0.4, by, -0.6),
      P(DOOR_X + hw + 0.4, by, DOOR_H + 0.4), P(DOOR_X - hw - 0.4, by, DOOR_H + 0.4)];
    poly(pq, "#04070b");
    const g = ctx.createLinearGradient(0, pq[0][1], 0, pq[3][1]);
    g.addColorStop(0, "rgba(94,234,212,0.20)");
    g.addColorStop(1, "rgba(94,234,212,0)");
    poly(pq, g);

    // floor
    cuboid((RX0 + RX1) / 2, (RY0 + RY1) / 2, RX1 - RX0, RY1 - RY0, 0, -1.2, 1.2, [36, 46, 60], [28, 38, 50]);
    ctx.strokeStyle = "rgba(94,234,212,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = RX0; x <= RX1; x += 2) {
      const a = P(x, RY0, 0), b = P(x, RY1, 0);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    for (let y = RY0; y <= RY1; y += 2) {
      const a = P(RX0, y, 0), b = P(RX1, y, 0);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();

    // print bed inlay
    poly([P(-B, -B, 0), P(B, -B, 0), P(B, B, 0), P(-B, B, 0)], "#1a2532", rgb(accent));
    ctx.strokeStyle = rgb(accent);
    ctx.globalAlpha = 0.2;
    ctx.beginPath();
    for (let i = 1; i < 6; i++) {
      const v = -B + (i * 2 * B) / 6;
      let a = P(v, -B, 0), b = P(v, B, 0);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      a = P(-B, v, 0); b = P(B, v, 0);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // walls
    const wc = [44, 56, 74], wt = [58, 72, 92];
    cuboid(RX0 - WT / 2, (RY0 - WT + RY1) / 2, WT, RY1 - RY0 + WT, 0, 0, WALL_H, wc, wt);
    const wall = (x0, x1, z0, z1) =>
      cuboid((x0 + x1) / 2, RY0 - WT / 2, x1 - x0, WT, 0, z0, z1 - z0, wc, wt);
    wall(RX0 - WT, DOOR_X - hw, 0, WALL_H);
    wall(DOOR_X + hw, RX1, 0, WALL_H);
    wall(DOOR_X - hw, DOOR_X + hw, DOOR_H, WALL_H);

    // door frame + exit sign
    ctx.save();
    ctx.strokeStyle = "rgb(94,234,212)";
    ctx.shadowColor = "rgb(94,234,212)";
    ctx.shadowBlur = 10;
    ctx.lineWidth = Math.max(1.5, S * 0.12);
    ctx.lineJoin = "round";
    ctx.beginPath();
    [P(DOOR_X - hw, RY0, 0), P(DOOR_X - hw, RY0, DOOR_H), P(DOOR_X + hw, RY0, DOOR_H), P(DOOR_X + hw, RY0, 0)]
      .forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.shadowColor = "rgb(94,234,212)";
    ctx.shadowBlur = 12;
    cuboid(DOOR_X, RY0 + 0.16, 2.4, 0.3, 0, DOOR_H + 0.45, 0.7, [94, 234, 212]);
    ctx.restore();
  }

  function drawPrinter() {
    const px = -B - 0.6;
    cuboid(px, -B - 0.6, 0.7, 0.7, 0, 0, POST_H, [58, 70, 88]);
    cuboid(px, B + 0.6, 0.7, 0.7, 0, 0, POST_H, [58, 70, 88]);
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

    if (p.alive && p.py > RY0 + 1.5) {
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
      const behind = it.cy < RY0;
      ctx.save();
      if (behind) {
        // only visible through the doorway, fading into the dark
        const a = P(DOOR_X - hw, RY0, DOOR_H);
        ctx.beginPath();
        [P(DOOR_X - hw, RY0 - WT, 0), P(DOOR_X + hw, RY0, 0), P(DOOR_X + hw, RY0, DOOR_H),
          [a[0] + WT * C30 * S, a[1] + WT * S30 * S]]
          .forEach((v, i) => (i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1])));
        ctx.closePath();
        ctx.clip();
        ctx.globalAlpha = 1 - sm((RY0 - it.cy - 1.5) / 4.5);
      }
      if (glow) {
        ctx.shadowColor = rgb(accent);
        ctx.shadowBlur = 14;
      }
      cuboid(it.cx, it.cy, q.w, q.d, p.th, it.z, ph, col, top, true);
      ctx.restore();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, Hpx);
    const p = pose();
    drawRoom();
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
    nz = 9.2;
    pauseBtn.textContent = "Play";
  }

  requestAnimationFrame(frame);
})();

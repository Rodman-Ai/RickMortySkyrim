// Unified input. Tracks keyboard, mouse, pointer-lock, and touch (joystick + look-drag + buttons).
export class Input {
  constructor() {
    this.keys = new Set();
    this.mouse = { dx: 0, dy: 0 };
    this.pointerLocked = false;
    this.sensitivity = 1;
    this.invertY = false;
    this.justPressed = new Set();
    this._consumed = new Set();

    // Mobile state
    this.joy = { active: false, dx: 0, dy: 0, id: -1 };
    this.lookId = -1;
    this.lookLastX = 0; this.lookLastY = 0;
    this.touchActions = new Set();   // pulse: cleared each frame after read
    this.touchActionsPressed = new Set(); // momentary: stays pressed until release
    this.isTouch = matchMedia("(pointer: coarse)").matches;

    this._bind();
  }

  _bind() {
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.justPressed.add(k);
      this.keys.add(k);
      // Prevent default for game keys
      if (["w","a","s","d"," ","tab","escape","e","f","1","2","3","4","5","6","7","8","m","q"].includes(k)) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
    });

    const canvas = document.getElementById("game");
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) { this.justPressed.add("mouse0"); this.keys.add("mouse0"); }
      if (e.button === 2) { this.justPressed.add("mouse2"); this.keys.add("mouse2"); }
    });
    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.keys.delete("mouse0");
      if (e.button === 2) this.keys.delete("mouse2");
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("click", () => {
      if (!this.pointerLocked && !this.isTouch) {
        canvas.requestPointerLock?.();
      }
    });
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    window.addEventListener("mousemove", (e) => {
      if (this.pointerLocked) {
        this.mouse.dx += e.movementX;
        this.mouse.dy += e.movementY;
      }
    });

    this._bindTouch();
  }

  _bindTouch() {
    const joyZone = document.getElementById("joystick-zone");
    const joyBase = document.getElementById("joystick-base");
    const joyKnob = document.getElementById("joystick-knob");
    const lookZone = document.getElementById("look-zone");

    const placeJoy = (x, y) => {
      const rect = joyZone.getBoundingClientRect();
      joyBase.style.left = (x - rect.left - 65) + "px";
      joyBase.style.bottom = (rect.bottom - y - 65) + "px";
    };

    joyZone.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      this.joy.active = true; this.joy.id = t.identifier;
      placeJoy(t.clientX, t.clientY);
      this.joy.cx = t.clientX; this.joy.cy = t.clientY;
      this.joy.dx = 0; this.joy.dy = 0;
      e.preventDefault();
    }, { passive: false });
    joyZone.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.joy.id) continue;
        const dx = t.clientX - this.joy.cx;
        const dy = t.clientY - this.joy.cy;
        const mag = Math.min(60, Math.hypot(dx, dy));
        const ang = Math.atan2(dy, dx);
        const nx = Math.cos(ang) * mag, ny = Math.sin(ang) * mag;
        joyKnob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
        this.joy.dx = nx / 60; this.joy.dy = ny / 60;
      }
      e.preventDefault();
    }, { passive: false });
    const endJoy = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.joy.id) {
          this.joy.active = false; this.joy.id = -1;
          this.joy.dx = 0; this.joy.dy = 0;
          joyKnob.style.transform = "translate(-50%, -50%)";
        }
      }
    };
    joyZone.addEventListener("touchend", endJoy);
    joyZone.addEventListener("touchcancel", endJoy);

    lookZone.addEventListener("touchstart", (e) => {
      if (this.lookId !== -1) return;
      const t = e.changedTouches[0];
      this.lookId = t.identifier;
      this.lookLastX = t.clientX; this.lookLastY = t.clientY;
      e.preventDefault();
    }, { passive: false });
    lookZone.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.lookId) continue;
        this.mouse.dx += (t.clientX - this.lookLastX) * 1.5;
        this.mouse.dy += (t.clientY - this.lookLastY) * 1.5;
        this.lookLastX = t.clientX; this.lookLastY = t.clientY;
      }
      e.preventDefault();
    }, { passive: false });
    const endLook = (e) => {
      for (const t of e.changedTouches) if (t.identifier === this.lookId) this.lookId = -1;
    };
    lookZone.addEventListener("touchend", endLook);
    lookZone.addEventListener("touchcancel", endLook);

    // Action buttons
    for (const btn of document.querySelectorAll("[data-act]")) {
      const act = btn.dataset.act;
      const press = (e) => {
        this.touchActions.add(act);
        this.touchActionsPressed.add(act);
        this.justPressed.add("act:" + act);
        e.preventDefault();
      };
      const release = (e) => {
        this.touchActionsPressed.delete(act);
        e.preventDefault();
      };
      btn.addEventListener("touchstart", press, { passive: false });
      btn.addEventListener("touchend", release, { passive: false });
      btn.addEventListener("mousedown", press);
      btn.addEventListener("mouseup", release);
    }
  }

  // === Gamepad (#84) ===
  // Polled each frame from poll(). Maps a standard layout:
  // left stick → move, right stick → look,
  // A (0)=jump, X (2)=melee, B (1)=ranged, Y (3)=interact,
  // LB (4)=shout1, LT (6)=shout2, RB (5)=shout3, RT (7)=ranged,
  // Start (9)=menu, dpad-up/down/left/right (12-15)=hotslot 1-4.
  _readGamepad(r) {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) return;
    if (!this._padPrev) this._padPrev = { buttons: [], hotslot: -1 };
    const ax = pad.axes;
    const dz = (v) => Math.abs(v) < 0.18 ? 0 : v;
    // Left stick (sticks 0,1) → move
    const mx = dz(ax[0] || 0);
    const my = dz(ax[1] || 0);
    if (mx || my) {
      r.moveX = mx;
      r.moveZ = my;
    }
    // Right stick (sticks 2,3) → look (delta-style)
    const lx = dz(ax[2] || 0);
    const ly = dz(ax[3] || 0);
    r.lookX += lx * 0.05 * this.sensitivity;
    r.lookY += ly * 0.05 * this.sensitivity * (this.invertY ? -1 : 1);
    // Buttons (edge-triggered for "pressed", held for "down")
    const btn = (i) => pad.buttons[i] && pad.buttons[i].pressed;
    const justBtn = (i) => btn(i) && !this._padPrev.buttons[i];
    if (justBtn(0)) r.jump = true;
    if (justBtn(2)) r.melee = true;
    if (justBtn(7) || justBtn(5)) r.ranged = true;
    if (justBtn(3)) r.interact = true;
    if (justBtn(9)) r.menu = true;
    if (justBtn(4)) r.shout1 = true;
    if (justBtn(6)) r.shout2 = true;
    if (justBtn(8)) r.shout3 = true;     // back/select for shout3 (no triggers free)
    // Sprint while LB held
    if (btn(10)) r.sprint = true;
    // D-pad → hotbar slots 1-4
    if (justBtn(12)) r.hotbar = 0;
    if (justBtn(13)) r.hotbar = 1;
    if (justBtn(14)) r.hotbar = 2;
    if (justBtn(15)) r.hotbar = 3;
    // Snapshot button states for next frame
    this._padPrev.buttons = pad.buttons.map((b) => b && b.pressed);
  }

  // Each frame: returns movement vector (-1..1) and "look delta", consuming mouse/touch deltas.
  poll() {
    const r = {
      moveX: 0, moveZ: 0,
      lookX: this.mouse.dx * 0.0025 * this.sensitivity,
      lookY: this.mouse.dy * 0.0025 * this.sensitivity * (this.invertY ? -1 : 1),
      sprint: this.keys.has("shift"),
      jump: this.justPressed.has(" ") || this.justPressed.has("act:jump"),
      melee: this.justPressed.has("mouse0") || this.justPressed.has("act:melee"),
      ranged: this.justPressed.has("mouse2") || this.justPressed.has("f") || this.justPressed.has("act:ranged"),
      interact: this.justPressed.has("e") || this.justPressed.has("act:interact"),
      shout1: this.justPressed.has("1") || this.justPressed.has("act:shout1"),
      shout2: this.justPressed.has("2") || this.justPressed.has("act:shout2"),
      shout3: this.justPressed.has("3") || this.justPressed.has("act:shout3"),
      menu: this.justPressed.has("tab") || this.justPressed.has("escape") || this.justPressed.has("act:menu"),
      map: this.justPressed.has("m"),
      hotbar: -1,                 // -1 = no slot pressed; gamepad/keys may set 0..4
    };
    // Hotbar keys 4-8 (avoiding conflict with shout keys 1-3)
    const HOTBAR_KEYS = ["4", "5", "6", "7", "8"];
    for (let i = 0; i < HOTBAR_KEYS.length; i++) {
      if (this.justPressed.has(HOTBAR_KEYS[i])) r.hotbar = i;
    }
    // Gamepad layer (overlays r if a pad is connected)
    this._readGamepad(r);
    this.mouse.dx = 0; this.mouse.dy = 0;
    // WASD
    if (this.keys.has("w")) r.moveZ -= 1;
    if (this.keys.has("s")) r.moveZ += 1;
    if (this.keys.has("a")) r.moveX -= 1;
    if (this.keys.has("d")) r.moveX += 1;
    // Joystick overrides if active
    if (this.joy.active) {
      r.moveX = this.joy.dx;
      r.moveZ = this.joy.dy;
      // Larger pushes auto-sprint
      if (Math.hypot(this.joy.dx, this.joy.dy) > 0.85) r.sprint = true;
    }
    // Normalize
    const m = Math.hypot(r.moveX, r.moveZ);
    if (m > 1) { r.moveX /= m; r.moveZ /= m; }

    this.justPressed.clear();
    this.touchActions.clear();
    return r;
  }

  setSens(v) { this.sensitivity = v; }
  setInvertY(v) { this.invertY = v; }
}

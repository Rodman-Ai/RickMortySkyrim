// UI controller: HUD bars, dialogue, menu tabs, minimap, toasts, zone banner.
import * as THREE from "three";
import { ITEMS, POIS, ZONES, FLAVOR, NPCS } from "./data.js";
import { sfx } from "./audio.js";

export class UI {
  constructor(game) {
    this.game = game;

    // Element refs
    this.$ = (id) => document.getElementById(id);
    this.barHP = this.$("bar-hp");
    this.barMP = this.$("bar-mp");
    this.barST = this.$("bar-st");
    this.compassStrip = this.$("compass-strip");
    this.compassWaypoint = this.$("compass-waypoint");
    this.schmecklesNum = this.$("schmeckles-num");
    this.questTrackerText = this.$("quest-tracker-text");
    this.interactHint = this.$("interact-hint");
    this.crosshair = this.$("crosshair");
    this.floaters = this.$("floaters");
    this.enemyBars = this.$("enemy-bars");
    this.toastEl = this.$("toast");
    this.zoneBanner = this.$("zone-banner");
    this.damageVignette = this.$("damage-vignette");
    this.cdEls = Array.from(document.querySelectorAll("#cooldowns .cd"));
    this.dialogue = this.$("dialogue");
    this.dlgName = this.$("dlg-name");
    this.dlgText = this.$("dlg-text");
    this.dlgOptions = this.$("dlg-options");
    this.menu = this.$("menu");
    this.tabBtns = Array.from(document.querySelectorAll(".tab"));
    this.deathScreen = this.$("death-screen");
    this.deathMsg = this.$("death-msg");

    // Reusable scratch vector for projection
    this._proj = new THREE.Vector3();
    // Pool of enemy bar DOM nodes keyed by enemy id
    this._enemyBarMap = new Map();

    // Compass numerals
    this._buildCompass();
    this._bindMenuTabs();

    this._toastTimer = 0;
    this._zoneTimer = 0;
    this._currentZoneId = null;
    this._dialogueOpen = false;
    this._dialogueCtx = null;
  }

  _buildCompass() {
    const cardinals = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    const html = [];
    for (let deg = -180; deg <= 540; deg += 15) {
      const norm = ((deg % 360) + 360) % 360;
      if (cardinals[norm]) html.push(`<span class="tick cardinal">${cardinals[norm]}</span>`);
      else html.push(`<span class="tick">${norm}°</span>`);
    }
    this.compassStrip.innerHTML = html.join("");
  }

  _bindMenuTabs() {
    for (const b of this.tabBtns) {
      b.addEventListener("click", () => {
        for (const x of this.tabBtns) x.classList.remove("active");
        b.classList.add("active");
        for (const t of document.querySelectorAll(".tab-body")) t.classList.add("hidden");
        this.$("tab-" + b.dataset.tab).classList.remove("hidden");
        if (b.dataset.tab === "inventory") this._renderInventory();
        if (b.dataset.tab === "quests") this._renderQuests();
        if (b.dataset.tab === "stats") this._renderStats();
        if (b.dataset.tab === "map") this._renderMap();
        sfx.ui();
      });
    }
  }

  showHUD(show) { this.$("hud").classList.toggle("hidden", !show); }
  showMobileUI(show) { this.$("mobile-ui").classList.toggle("hidden", !show); }
  showTitle(show) { this.$("title-screen").classList.toggle("hidden", !show); }
  showLoading(show, status, pct) {
    this.$("loading").classList.toggle("hidden", !show);
    if (status) this.$("loading-status").textContent = status;
    if (pct != null) this.$("loading-fill").style.width = pct + "%";
  }
  showHelp(show) { this.$("help-screen").classList.toggle("hidden", !show); }
  showDeath(show, msg) {
    this.deathScreen.classList.toggle("hidden", !show);
    if (msg) this.deathMsg.textContent = msg;
  }

  toast(msg, ms = 2500) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("show");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toastEl.classList.remove("show"), ms);
  }
  flavor() { this.toast(FLAVOR[(Math.random() * FLAVOR.length) | 0]); }

  zoneBannerSet(name) {
    this.zoneBanner.textContent = name;
    this.zoneBanner.classList.remove("hidden");
    clearTimeout(this._zoneT);
    this.zoneBanner.style.opacity = "1";
    this._zoneT = setTimeout(() => { this.zoneBanner.style.opacity = "0"; setTimeout(() => this.zoneBanner.classList.add("hidden"), 1000); }, 2400);
    sfx.zone();
  }

  // Called every frame
  update(dt, player, world, npcMgr) {
    this.barHP.style.width = (player.hp / player.maxHP * 100) + "%";
    this.barMP.style.width = (player.mp / player.maxMP * 100) + "%";
    this.barST.style.width = (player.st / player.maxST * 100) + "%";
    this.schmecklesNum.textContent = Math.floor(player.schmeckles);

    // Compass
    const yawDeg = (player.yaw * 180 / Math.PI) % 360;
    const offset = (-yawDeg) * (50 / 15);
    this.compassStrip.style.transform = `translateX(${offset}px)`;

    // Damage vignette
    this.damageVignette.style.opacity = Math.max(0, player.hitFlash / 0.4);

    // Cooldowns
    for (let i = 0; i < 3; i++) {
      const cd = this.cdEls[i];
      const t = player.shoutCD[i] / player.shoutMax[i];
      cd.querySelector(".cd-fill").style.height = (t * 100) + "%";
      cd.classList.toggle("ready", t <= 0);
    }

    // Active quest tracker + compass waypoint
    const qActive = this.game.questLog.active && this.game.questLog.quests[this.game.questLog.active];
    if (qActive) {
      const o = qActive.def.objectives[0];
      const p = qActive.progress[0].count;
      this.questTrackerText.innerHTML = `<b>${qActive.def.title}</b><br/>${p}/${o.count} ${qActive.def.text}`;
      this._updateWaypoint(qActive, player);
    } else {
      this.questTrackerText.textContent = "—";
      this.compassWaypoint.classList.add("hidden");
    }

    // Force-refresh camera matrices so projection is correct this frame
    player.camera.updateMatrixWorld(true);

    // Project enemies / floaters / waypoints to screen
    this._updateEnemyBars(player);
    this._updateFloaters(dt, player);
    this._updateCrosshair(player);

    // Zone banner on entry
    const zone = this._zoneAt(player.pos.x, player.pos.z);
    if (zone && zone.id !== this._currentZoneId) {
      this._currentZoneId = zone.id;
      this.zoneBannerSet(zone.name);
    }

    // Interact hint
    const npc = npcMgr.nearestInRange(player, 3.0);
    if (npc) {
      this.interactHint.textContent = `[E] Talk to ${npc.name}`;
      this.interactHint.classList.remove("hidden");
    } else if (world._containers && world._containers.find((c) => !c.opened && Math.hypot(c.x - player.pos.x, c.z - player.pos.z) < 1.6)) {
      this.interactHint.textContent = "[E] Open container";
      this.interactHint.classList.remove("hidden");
    } else if (world.lostPlumbus && !world.lostPlumbus.taken) {
      const lp = world.lostPlumbus;
      const d = Math.hypot(player.pos.x - lp.x, player.pos.z - lp.z);
      if (d < 2.2) {
        this.interactHint.textContent = "[E] Pick up Lost Plumbus";
        this.interactHint.classList.remove("hidden");
      } else this.interactHint.classList.add("hidden");
    } else {
      // Shrine?
      const shrine = world.shrines.find((s) => Math.hypot(s.x - player.pos.x, s.z - player.pos.z) < 2.0);
      if (shrine) {
        this.interactHint.textContent = "[E] Pray at Shrine (heal & save)";
        this.interactHint.classList.remove("hidden");
      } else this.interactHint.classList.add("hidden");
    }
  }

  _zoneAt(x, z) {
    let nearest = null, nd = Infinity;
    for (const z0 of ZONES) {
      const d = Math.hypot(x - z0.cx, z - z0.cz);
      if (d < z0.r * 1.1 && d < nd) { nd = d; nearest = z0; }
    }
    return nearest;
  }

  // === Menu ===
  toggleMenu() {
    if (this._dialogueOpen) return;
    const open = this.menu.classList.contains("hidden");
    this.menu.classList.toggle("hidden", !open);
    this.game.setPaused(open);
    if (open && document.pointerLockElement) document.exitPointerLock?.();
    if (open) {
      // Render current tab
      const active = document.querySelector(".tab.active").dataset.tab;
      this.$(`tab-${active}`).classList.remove("hidden");
      if (active === "inventory") this._renderInventory();
      if (active === "quests") this._renderQuests();
      if (active === "stats") this._renderStats();
      if (active === "map") this._renderMap();
    }
    sfx.ui();
  }

  _renderInventory() {
    const inv = this.game.inventory;
    const eq = this.game.player.equipped;
    const items = inv.list();
    const html = items.length === 0 ? `<p>Your inventory is as empty as Jerry's calendar.</p>` :
      `<div class="inv-grid">${items.map(({ key, count, def }) => {
        const isEq = eq.melee === key || eq.ranged === key || eq.head === key || eq.body === key;
        const action = def.type === "weapon" ? `Equip` :
                       def.type === "armor" ? `Wear` :
                       def.type === "consume" ? `Use` :
                       "";
        return `<div class="inv-item${isEq ? " equipped" : ""}" data-key="${key}">
          <div class="name">${def.icon || "•"} ${def.name}${count > 1 ? ` ×${count}` : ""}</div>
          <div class="desc">${def.desc}</div>
          ${action ? `<button class="inv-act" data-key="${key}">${action}</button>` : ""}
        </div>`;
      }).join("")}</div>`;
    const el = this.$("tab-inventory");
    el.innerHTML = html;
    for (const b of el.querySelectorAll(".inv-act")) {
      b.addEventListener("click", (e) => { e.stopPropagation(); this._useItem(b.dataset.key); });
    }
  }
  _useItem(key) {
    const def = ITEMS[key];
    const player = this.game.player;
    if (def.type === "weapon") {
      player.equipped[def.slot] = key;
      this.toast(`Equipped: ${def.name}`);
    } else if (def.type === "armor") {
      player.equipped[def.slot] = key;
      this.toast(`Wearing: ${def.name}`);
    } else if (def.type === "consume") {
      if (def.effect === "hp") player.hp = Math.min(player.maxHP, player.hp + def.value);
      if (def.effect === "mp") player.mp = Math.min(player.maxMP, player.mp + def.value);
      if (def.effect === "buff") { player.buffMult = 1 + def.value / 100; player.buffTimer = 30; }
      if (def.effect === "summon") { this.game.summonMeeseeks(); }
      this.game.inventory.remove(key, 1);
      sfx.pickup();
    }
    this._renderInventory();
  }

  _renderQuests() {
    const ql = this.game.questLog;
    const ids = Object.keys(ql.quests);
    const el = this.$("tab-quests");
    if (ids.length === 0) { el.innerHTML = `<p>No quests yet. Go talk to someone.</p>`; return; }
    el.innerHTML = ids.map((id) => {
      const q = ql.quests[id];
      const obj = q.def.objectives[0];
      const status = q.turnedIn ? "Turned in" : q.done ? "Ready to turn in" : `${q.progress[0].count}/${obj.count}`;
      return `<div class="quest ${q.done ? "done" : "active"}">
        <div class="title">${q.def.title}</div>
        <div class="obj">${q.def.text}</div>
        <div class="obj">Progress: ${status}</div>
        ${!q.turnedIn ? `<button data-trk="${id}">Track</button>` : ""}
      </div>`;
    }).join("");
    for (const b of el.querySelectorAll("[data-trk]")) {
      b.addEventListener("click", () => { ql.active = b.dataset.trk; this._renderQuests(); });
    }
  }

  _renderStats() {
    const p = this.game.player;
    const eq = p.equipped;
    const el = this.$("tab-stats");
    const eqStr = (k) => k ? ITEMS[k].name : "—";
    el.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div><h3>Vital Stats</h3>
        <p>Level ${p.level} · ${p.xp}/${p.xpToNext} XP</p>
        <p>HP: ${Math.floor(p.hp)} / ${p.maxHP}</p>
        <p>Schwifty: ${Math.floor(p.mp)} / ${p.maxMP}</p>
        <p>Stamina: ${Math.floor(p.st)} / ${p.maxST}</p>
        <p>Schmeckles: ${Math.floor(p.schmeckles)}</p>
        </div>
        <div><h3>Equipment</h3>
        <p>Melee: ${eqStr(eq.melee)}</p>
        <p>Ranged: ${eqStr(eq.ranged)}</p>
        <p>Head: ${eqStr(eq.head)}</p>
        <p>Body: ${eqStr(eq.body)}</p>
        </div>
      </div>
    `;
  }

  _renderMap() {
    const c = document.getElementById("minimap-canvas");
    const ctx = c.getContext("2d");
    const W = c.width, H = c.height;
    const wsize = 600;
    const wx = (x) => (x + wsize / 2) / wsize * W;
    const wy = (z) => (z + wsize / 2) / wsize * H;
    ctx.fillStyle = "#0a0d18"; ctx.fillRect(0, 0, W, H);
    // Zones
    for (const z of ZONES) {
      ctx.fillStyle = "#" + z.color.toString(16).padStart(6, "0");
      ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.arc(wx(z.cx), wy(z.cz), (z.r / wsize) * W, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // POIs
    ctx.fillStyle = "#aa88ff";
    for (const p of POIS) {
      ctx.beginPath(); ctx.arc(wx(p.x), wy(p.z), 4, 0, Math.PI * 2); ctx.fill();
    }
    // NPCs
    ctx.fillStyle = "#ffd166";
    for (const n of this.game.npcMgr.list) {
      ctx.beginPath(); ctx.arc(wx(n._x), wy(n._z), 5, 0, Math.PI * 2); ctx.fill();
    }
    // Enemies
    ctx.fillStyle = "#ff5577";
    for (const e of this.game.enemyMgr.list) {
      if (e.dead) continue;
      ctx.beginPath(); ctx.arc(wx(e.x), wy(e.z), e.boss ? 6 : 3, 0, Math.PI * 2); ctx.fill();
    }
    // Player
    const px = wx(this.game.player.pos.x), py = wy(this.game.player.pos.z);
    ctx.strokeStyle = "#5dffd1"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
    // Heading triangle
    const a = -this.game.player.yaw + Math.PI;
    ctx.fillStyle = "#5dffd1";
    ctx.beginPath();
    ctx.moveTo(px + Math.sin(a) * 10, py - Math.cos(a) * 10);
    ctx.lineTo(px + Math.sin(a + 2.5) * 5, py - Math.cos(a + 2.5) * 5);
    ctx.lineTo(px + Math.sin(a - 2.5) * 5, py - Math.cos(a - 2.5) * 5);
    ctx.closePath(); ctx.fill();

    // Labels
    ctx.fillStyle = "#cce";
    ctx.font = "11px sans-serif";
    for (const z of ZONES) ctx.fillText(z.name, wx(z.cx) + 8, wy(z.cz) - 4);
  }

  // === Dialogue ===
  openDialogue(npc, nodeId = "start") {
    this._dialogueOpen = true;
    this._dialogueCtx = { npc, nodeId };
    this.dialogue.classList.remove("hidden");
    this._renderDialogueNode();
    this.game.setPaused(true);
    if (document.pointerLockElement) document.exitPointerLock?.();
  }
  _renderDialogueNode() {
    const { npc, nodeId } = this._dialogueCtx;
    const node = npc.dialogue[nodeId];
    if (!node) return this.closeDialogue();
    this.dlgName.textContent = npc.name;
    this.dlgText.textContent = node.text;
    this.dlgOptions.innerHTML = "";
    (node.options || []).forEach((opt) => {
      const b = document.createElement("button");
      b.textContent = opt.text;
      b.addEventListener("click", () => this._chooseOption(opt));
      this.dlgOptions.appendChild(b);
    });
  }
  _chooseOption(opt) {
    sfx.ui();
    if (opt.give) this.game.questLog.give(opt.give);
    if (opt.reward) {
      if (opt.reward.item) {
        this.game.inventory.add(opt.reward.item, opt.reward.count || 1);
        // Auto-equip first weapon/armor pickup
        const def = ITEMS[opt.reward.item];
        if (def.type === "weapon" && !this.game.player.equipped[def.slot]) this.game.player.equipped[def.slot] = opt.reward.item;
        if (def.type === "armor" && !this.game.player.equipped[def.slot]) this.game.player.equipped[def.slot] = opt.reward.item;
        this.toast(`Received: ${def.name}`);
      }
      if (opt.reward.schmeckles) {
        this.game.player.schmeckles += opt.reward.schmeckles;
        sfx.schmeckle();
      }
    }
    if (opt.next) {
      this._dialogueCtx.nodeId = opt.next;
      this._renderDialogueNode();
    } else if (opt.end) {
      // Complete any ready turn-in for this NPC?
      const turnIn = this.game.questLog.pendingTurnIn(this._dialogueCtx.npc.id);
      if (turnIn && this._dialogueCtx.nodeId === turnIn.node) {
        this.game.questLog.finishTurnIn(turnIn.questId);
        sfx.questDone();
      }
      this.closeDialogue();
    }
  }
  closeDialogue() {
    this._dialogueOpen = false;
    this._dialogueCtx = null;
    this.dialogue.classList.add("hidden");
    this.game.setPaused(false);
  }
  isDialogueOpen() { return this._dialogueOpen; }
  isMenuOpen() { return !this.menu.classList.contains("hidden"); }

  // === Damage floaters ===
  // worldX/Y/Z is the spawn position; kind is "enemy" (yellow) or "player" (red)
  spawnDamage(x, y, z, amount, kind = "enemy") {
    const el = document.createElement("div");
    el.className = "floater " + kind + (amount >= 50 ? " crit" : "");
    el.textContent = "-" + Math.round(amount);
    el.dataset.wx = x; el.dataset.wy = y; el.dataset.wz = z;
    el.dataset.born = performance.now();
    this.floaters.appendChild(el);
    // Clean up after animation
    setTimeout(() => el.remove(), 1100);
  }

  _updateFloaters(dt, player) {
    if (!this.floaters.children.length) return;
    const cam = player.camera;
    const w = window.innerWidth, h = window.innerHeight;
    const fwd = this._fwdScratch || (this._fwdScratch = new THREE.Vector3());
    cam.getWorldDirection(fwd);
    for (const el of this.floaters.children) {
      const wx = +el.dataset.wx, wy = +el.dataset.wy, wz = +el.dataset.wz;
      // Behind-camera cull
      const ax = wx - cam.position.x, ay = wy - cam.position.y, az = wz - cam.position.z;
      if (ax * fwd.x + ay * fwd.y + az * fwd.z <= 0) { el.style.display = "none"; continue; }
      this._proj.set(wx, wy, wz).project(cam);
      el.style.display = "";
      el.style.left = ((this._proj.x + 1) * 0.5 * w) + "px";
      el.style.top = ((-this._proj.y + 1) * 0.5 * h) + "px";
    }
  }

  // === Enemy HP bars ===
  _updateEnemyBars(player) {
    const cam = player.camera;
    const w = window.innerWidth, h = window.innerHeight;
    const fwd = this._fwdScratch || (this._fwdScratch = new THREE.Vector3());
    cam.getWorldDirection(fwd);
    const seen = new Set();
    for (const e of this.game.enemyMgr.list) {
      if (e.dead) continue;
      const visible = (e.aggro || e.hp < e.maxHP || e.boss) && (Math.hypot(e.x - player.pos.x, e.z - player.pos.z) < 80);
      if (!visible) continue;
      const wy = e.y + (e.boss ? 16 : 2.6);
      const ax = e.x - cam.position.x, ay = wy - cam.position.y, az = e.z - cam.position.z;
      if (ax * fwd.x + ay * fwd.y + az * fwd.z <= 0) continue; // behind camera
      this._proj.set(e.x, wy, e.z).project(cam);
      seen.add(e.id);
      let bar = this._enemyBarMap.get(e.id);
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "enemy-bar" + (e.boss ? " boss" : "");
        bar.innerHTML = `<div class="nm"></div><div class="track"><div class="fill"></div></div>`;
        this.enemyBars.appendChild(bar);
        this._enemyBarMap.set(e.id, bar);
      }
      bar.style.left = ((this._proj.x + 1) * 0.5 * w) + "px";
      bar.style.top = ((-this._proj.y + 1) * 0.5 * h) + "px";
      const nameMap = { cronenberg: "Cronenberg", trooper: "Federation Trooper", meeseeks: "Mr. Meeseeks", cromulon: "CROMULON" };
      bar.querySelector(".nm").textContent = nameMap[e.type] || e.type;
      bar.querySelector(".fill").style.width = Math.max(0, e.hp / e.maxHP * 100) + "%";
    }
    // Remove stale bars
    for (const [id, el] of this._enemyBarMap) {
      if (!seen.has(id)) { el.remove(); this._enemyBarMap.delete(id); }
    }
  }

  // === Crosshair targeting ===
  _updateCrosshair(player) {
    const fwd = new THREE.Vector3();
    player.camera.getWorldDirection(fwd);
    let onEnemy = false;
    let bestT = Infinity, bestE = null;
    for (const e of this.game.enemyMgr.list) {
      if (e.dead) continue;
      const dx = e.x - player.pos.x;
      const dy = (e.y + 1.2) - player.pos.y;
      const dz = e.z - player.pos.z;
      const along = dx * fwd.x + dy * fwd.y + dz * fwd.z;
      if (along < 0.5 || along > 60) continue;
      // Closest distance from line to enemy center
      const px = dx - along * fwd.x, py = dy - along * fwd.y, pz = dz - along * fwd.z;
      const off = Math.hypot(px, py, pz);
      const radius = e.hitR + 0.4;
      if (off > radius) continue;
      if (along < bestT) { bestT = along; bestE = e; }
    }
    onEnemy = !!bestE;
    this.crosshair.classList.toggle("on-enemy", onEnemy);
    // Soft emissive glow on the targeted enemy mesh
    if (this._lastTarget && this._lastTarget !== bestE) {
      this._lastTarget._highlight = false;
    }
    if (bestE) bestE._highlight = true;
    this._lastTarget = bestE;
  }

  // === Compass quest waypoint ===
  _updateWaypoint(activeQuest, player) {
    // Find a target in the world: NPC turn-in or enemy/POI of objective.
    const obj = activeQuest.def.objectives[0];
    let tx = null, tz = null, label = "";
    if (activeQuest.done) {
      const npc = NPCS.find((n) => n.id === activeQuest.def.next?.npc);
      if (npc) { tx = npc.pos[0]; tz = npc.pos[2]; label = "Turn in"; }
    } else if (obj.type === "kill") {
      // Closest live enemy of that type
      let bd = Infinity, found = null;
      for (const e of this.game.enemyMgr.list) {
        if (e.dead || e.type !== obj.target) continue;
        const d = Math.hypot(e.x - player.pos.x, e.z - player.pos.z);
        if (d < bd) { bd = d; found = e; }
      }
      if (found) { tx = found.x; tz = found.z; }
    } else if (obj.type === "pickup" && obj.target === "lost_plumbus") {
      const lp = this.game.world?.lostPlumbus;
      if (lp && !lp.taken) { tx = lp.x; tz = lp.z; }
    }
    if (tx === null) { this.compassWaypoint.classList.add("hidden"); return; }

    // Compass strip is positioned so center=current heading.
    // We render bearing relative to player's facing; clamp visually within strip.
    const compassEl = this.$("compass");
    const rect = compassEl.getBoundingClientRect();
    const ang = Math.atan2(tx - player.pos.x, tz - player.pos.z);  // bearing in world (z forward)
    let rel = ang - player.yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    const relDeg = -rel * 180 / Math.PI;        // -180..180 (negate because compass scrolls inverse)
    const clamped = Math.max(-90, Math.min(90, relDeg));
    const center = rect.left + rect.width / 2;
    const x = center + (clamped / 90) * (rect.width / 2 - 14);
    this.compassWaypoint.style.left = x + "px";
    this.compassWaypoint.style.top = (rect.bottom + 2) + "px";
    this.compassWaypoint.style.position = "fixed";
    this.compassWaypoint.classList.remove("hidden");
    this.compassWaypoint.title = label || "Quest target";
  }
}

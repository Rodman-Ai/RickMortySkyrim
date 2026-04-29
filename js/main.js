// Wubba Lubba Dub Dawn — main entry. Glues engine, world, player, AI, UI together.
import * as THREE from "three";
import { World, WORLD_SIZE, heightAt } from "./world.js";
import { Player } from "./player.js";
import { EnemyManager, Enemy } from "./enemies.js";
import { Combat } from "./combat.js";
import { NPCManager } from "./npcs.js";
import { Input } from "./controls.js";
import { Inventory } from "./inventory.js";
import { QuestLog } from "./quests.js";
import { UI } from "./ui.js";
import { sfx } from "./audio.js";
import { ITEMS, ZONES } from "./data.js";

const SAVE_KEY = "wubba_dub_dawn_save_v1";

class Game {
  constructor() {
    this.canvas = document.getElementById("game");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 600);
    this.clock = new THREE.Clock();
    this.timeOfDay = 0.35;
    this.timeScale = 1;
    this.slowTimer = 0;
    this.paused = false;
    this.started = false;
    this.respawn = { x: 0, y: 0, z: 0 };
    this.lastSaveAt = 0;

    this.input = new Input();
    this.ui = new UI(this);
    this.inventory = new Inventory();
    this.questLog = new QuestLog();

    this._handleResize = this._handleResize.bind(this);
    window.addEventListener("resize", this._handleResize);
    this._handleResize();
  }

  async start(loadSaved = false) {
    this.ui.showLoading(true, "Forging dimension C-137…", 5);
    await new Promise((r) => setTimeout(r, 30));
    this.world = new World(this.scene, this._quality);
    this.ui.showLoading(true, "Spawning Cronenbergs…", 35);
    await new Promise((r) => setTimeout(r, 30));
    this.player = new Player(this.camera);
    // Camera must be in the scene graph for the viewmodel (camera child) to render.
    this.scene.add(this.camera);
    this.enemyMgr = new EnemyManager(this.scene);
    this.enemyMgr.populateWorld();
    this.ui.showLoading(true, "Convincing Rick to participate…", 70);
    await new Promise((r) => setTimeout(r, 30));
    this.npcMgr = new NPCManager(this.scene);
    this.combat = new Combat(this.scene, this.player, this.enemyMgr, this.ui, this);

    // Starting kit
    this.inventory.add("plumbus", 1);
    this.inventory.add("plasmaRifle", 1);
    this.inventory.add("portalGun", 1);
    this.inventory.add("healJuice", 3);
    this.inventory.add("schwiftyPotion", 2);
    this.player.equipped.melee = "plumbus";
    this.player.equipped.ranged = "plasmaRifle";

    // Default respawn at Smith Garage shrine
    this.respawn = { x: 0, y: heightAt(0, 0) + 1.7, z: 0 };
    this.player.pos.set(0, heightAt(0, 0) + 1.7, 0);

    if (loadSaved) this._loadGame();

    this.ui.showLoading(false);
    this.ui.showHUD(true);
    if (this.input.isTouch) this.ui.showMobileUI(true);
    this.started = true;

    this._handleResize();
    this._loop();
  }

  _handleResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setQuality(q) {
    this._quality = q;
    this.renderer.setPixelRatio(q === "low" ? 1 : Math.min(window.devicePixelRatio, 2));
    if (this.scene.fog) this.scene.fog.far = q === "low" ? 200 : q === "high" ? 380 : 300;
  }

  setRenderDistance(d) {
    if (this.scene.fog) this.scene.fog.far = d;
    this.camera.far = d * 2;
    this.camera.updateProjectionMatrix();
  }

  setPaused(p) { this.paused = p; }
  slowTimeFor(seconds) {
    this.slowTimer = seconds;
    this.timeScale = 0.4;
  }

  onEnemyKilled(e) {
    this.questLog.onKill(e.type);
    if (e.type === "trooper") this.ui.toast(`Trooper defeated. (${this._questProgress("trooper")})`);
    if (e.type === "cronenberg") this.ui.toast(`Cronenberg dispatched. (${this._questProgress("cronenberg")})`);
    if (e.type === "cromulon") {
      this.ui.toast("YOU SHOWED THEM WHAT YOU'VE GOT!");
      sfx.questDone();
    }
  }
  _questProgress(type) {
    for (const id in this.questLog.quests) {
      const q = this.questLog.quests[id];
      if (q.def.objectives[0].type === "kill" && q.def.objectives[0].target === type) {
        return `${q.progress[0].count}/${q.def.objectives[0].count}`;
      }
    }
    return "";
  }

  summonMeeseeks() {
    // Friendly meeseeks aids briefly: spawn one that attacks nearest enemy. (Simplified: one-shot of damage)
    let nearest = null, nd = Infinity;
    for (const e of this.enemyMgr.list) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - this.player.pos.x, e.z - this.player.pos.z);
      if (d < nd) { nd = d; nearest = e; }
    }
    if (nearest) {
      nearest.hurt(60);
      this.combat._spawnExplosion(new THREE.Vector3(nearest.x, nearest.y + 1.2, nearest.z));
      this.ui.toast("CAN DO!");
    } else {
      this.ui.toast("EXISTENCE IS PAIN!");
    }
  }

  _interact() {
    // NPC?
    const npc = this.npcMgr.nearestInRange(this.player, 3.0);
    if (npc) {
      // Decide which node to open
      const turn = this.questLog.pendingTurnIn(npc.id);
      this.ui.openDialogue(npc, turn ? turn.node : "start");
      return;
    }
    // Lost plumbus?
    if (this.world.lostPlumbus && !this.world.lostPlumbus.taken) {
      const lp = this.world.lostPlumbus;
      const d = Math.hypot(this.player.pos.x - lp.x, this.player.pos.z - lp.z);
      if (d < 2.2) {
        lp.taken = true;
        this.scene.remove(lp.mesh);
        this.questLog.onPickup("lost_plumbus");
        this.ui.toast("Picked up: Lost Plumbus");
        sfx.pickup();
        return;
      }
    }
    // Container (chest/crate)?
    if (this.world._containers) {
      const c = this.world._containers.find((c) => !c.opened && Math.hypot(c.x - this.player.pos.x, c.z - this.player.pos.z) < 1.6);
      if (c) {
        c.opened = true;
        // Drop loot in front of the chest
        for (let i = 0; i < c.loot.length; i++) {
          const a = (i / c.loot.length) * Math.PI - Math.PI / 2;
          const dx = Math.cos(a) * 1.0, dz = Math.sin(a) * 1.0;
          this.combat._spawnLoot(c.x + dx, heightAt(c.x + dx, c.z + dz), c.z + dz, c.loot[i]);
        }
        this.ui.toast("Found loot!");
        sfx.pickup();
        return;
      }
    }

    // Shrine?
    const shrine = this.world.shrines.find((s) => Math.hypot(s.x - this.player.pos.x, s.z - this.player.pos.z) < 2.2);
    if (shrine) {
      this.player.hp = this.player.maxHP; this.player.mp = this.player.maxMP; this.player.st = this.player.maxST;
      this.respawn = { x: shrine.x, y: heightAt(shrine.x, shrine.z) + 1.7, z: shrine.z };
      this._saveGame();
      this.ui.toast("Healed and saved at Shrine.");
      sfx.questDone();
      return;
    }
    // Portal? (warp to another zone)
    for (const p of this.world.props) {
      if (p.type !== "portal") continue;
      const d = Math.hypot(this.player.pos.x - p.x, this.player.pos.z - p.z);
      if (d < 2.5) {
        // cycle to next zone
        const zones = ZONES.filter((z) => z.id !== "smith_garage");
        const idx = zones.findIndex((z) => Math.abs(z.cx + 4 - p.x) < 0.5 && Math.abs(z.cz - p.z) < 0.5);
        const next = zones[(idx + 1) % zones.length];
        this.player.pos.set(next.cx, heightAt(next.cx, next.cz) + 1.7, next.cz);
        this.ui.toast(`Portaled to ${next.name}`);
        sfx.shout1();
        return;
      }
    }
  }

  _saveGame() {
    const data = {
      v: 1,
      pos: [this.player.pos.x, this.player.pos.y, this.player.pos.z],
      yaw: this.player.yaw,
      hp: this.player.hp, mp: this.player.mp, st: this.player.st,
      maxHP: this.player.maxHP, maxMP: this.player.maxMP, maxST: this.player.maxST,
      level: this.player.level, xp: this.player.xp, xpToNext: this.player.xpToNext,
      schmeckles: this.player.schmeckles,
      equipped: this.player.equipped,
      inventory: this.inventory.serialize(),
      quests: this.questLog.serialize(),
      respawn: this.respawn,
      timeOfDay: this.timeOfDay,
      lostPlumbusTaken: this.world.lostPlumbus?.taken || false,
      enemiesKilled: this.enemyMgr.list.map((e) => ({ id: e.id, type: e.type, x: e.x, z: e.z, dead: e.dead, hp: e.hp })),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      this.lastSaveAt = performance.now();
    } catch (err) { console.warn("Save failed", err); }
  }

  _loadGame() {
    let data;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch { return; }
    if (!data) return;
    this.player.pos.set(data.pos[0], data.pos[1], data.pos[2]);
    this.player.yaw = data.yaw || 0;
    Object.assign(this.player, {
      hp: data.hp, mp: data.mp, st: data.st,
      maxHP: data.maxHP, maxMP: data.maxMP, maxST: data.maxST,
      level: data.level, xp: data.xp, xpToNext: data.xpToNext,
      schmeckles: data.schmeckles,
      equipped: data.equipped,
    });
    this.inventory.load(data.inventory);
    this.questLog.load(data.quests);
    this.respawn = data.respawn || { x: 0, y: 1.7, z: 0 };
    this.timeOfDay = data.timeOfDay ?? 0.35;
    if (data.lostPlumbusTaken && this.world.lostPlumbus) {
      this.world.lostPlumbus.taken = true;
      this.scene.remove(this.world.lostPlumbus.mesh);
    }
  }

  hasSave() { return !!localStorage.getItem(SAVE_KEY); }
  deleteSave() { localStorage.removeItem(SAVE_KEY); }

  // === Death/respawn ===
  _onDeath() {
    sfx.death();
    this.ui.showDeath(true);
  }
  _doRespawn() {
    this.player.pos.set(this.respawn.x, this.respawn.y, this.respawn.z);
    this.player.hp = this.player.maxHP * 0.6;
    this.player.mp = this.player.maxMP * 0.6;
    this.player.st = this.player.maxST;
    // Reset enemy aggro
    for (const e of this.enemyMgr.list) e.aggro = false;
    this.ui.showDeath(false);
  }

  // === Main loop ===
  _loop() {
    requestAnimationFrame(() => this._loop());
    if (!this.started) return;
    const dt = Math.min(0.05, this.clock.getDelta());

    const ip = this.input.poll();

    // Menu toggle works whether paused or not
    if (ip.menu && !this.ui.isDialogueOpen()) this.ui.toggleMenu();
    if (ip.map && !this.ui.isDialogueOpen()) {
      if (!this.ui.isMenuOpen()) this.ui.toggleMenu();
      document.querySelector('.tab[data-tab="map"]').click();
    }

    if (this.paused || this.ui.isDialogueOpen()) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Slow-time
    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      if (this.slowTimer <= 0) this.timeScale = 1;
    }
    const sdt = dt * this.timeScale;

    // Interact
    if (ip.interact) this._interact();

    this.player.update(sdt, ip, this.world, this.combat);
    this.enemyMgr.update(sdt, this.player, this.combat);
    this.combat.update(sdt);
    this.combat.tryPickupLoot(this.player);
    this.npcMgr.update(sdt, this.player, this.questLog);

    // Time of day advances (~4-min day)
    this.timeOfDay = (this.timeOfDay + dt / 240) % 1;
    this.world.update(dt, this.timeOfDay, this.player.pos);

    this.ui.update(dt, this.player, this.world, this.npcMgr);

    // Death
    if (this.player.hp <= 0 && this.ui.deathScreen.classList.contains("hidden")) {
      this._onDeath();
    }

    // Periodic autosave
    if (performance.now() - this.lastSaveAt > 30000) this._saveGame();

    this.renderer.render(this.scene, this.camera);
  }
}

// === Boot ===
const game = new Game();
window.__game = game;

// Inline script in index.html already registered window error handlers.
// We delegate to its showBootError so an in-game error replaces the loading text.
const showFatal = window.__showBootError || ((msg) => console.error(msg));

async function bootGame(loadSaved) {
  try {
    sfx.resume();
    if (!loadSaved) game.deleteSave();
    await game.start(loadSaved);
    document.getElementById("title-screen").classList.add("hidden");
  } catch (err) {
    showFatal("Boot failed: " + (err?.message || err));
  }
}

document.getElementById("btn-new").addEventListener("click", () => bootGame(false));
document.getElementById("btn-continue").addEventListener("click", () => {
  if (!game.hasSave()) { game.ui.toast("No save found. Start a new adventure!"); return; }
  bootGame(true);
});
document.getElementById("btn-help").addEventListener("click", () => {
  document.getElementById("help-screen").classList.remove("hidden");
});
document.getElementById("btn-help-close").addEventListener("click", () => {
  document.getElementById("help-screen").classList.add("hidden");
});

document.getElementById("btn-respawn").addEventListener("click", () => game._doRespawn());

// System tab
document.getElementById("btn-save").addEventListener("click", () => { game._saveGame(); game.ui.toast("Saved."); });
document.getElementById("btn-load").addEventListener("click", () => { game._loadGame(); game.ui.toast("Loaded."); });
document.getElementById("btn-reset").addEventListener("click", () => { game.deleteSave(); game.ui.toast("Save deleted."); });
document.getElementById("btn-quit").addEventListener("click", () => { game._saveGame(); location.reload(); });

document.getElementById("cfg-sens").addEventListener("input", (e) => game.input.setSens(parseFloat(e.target.value)));
document.getElementById("cfg-dist").addEventListener("input", (e) => game.setRenderDistance(parseFloat(e.target.value)));
document.getElementById("cfg-quality").addEventListener("change", (e) => game.setQuality(e.target.value));
document.getElementById("cfg-invert").addEventListener("change", (e) => game.input.setInvertY(e.target.checked));

// Mobile menu button handled via [data-act="menu"]? — explicit
document.getElementById("mobile-menu").addEventListener("click", () => game.ui.toggleMenu());

// Show title screen after a brief loading sim. ES modules run after
// DOMContentLoaded, so we kick this off immediately. Bail if a global
// error has been reported so we don't clobber the diagnostic message.
(function showLoaderThenTitle() {
  let p = 0;
  const tick = setInterval(() => {
    if (window.__bootError) { clearInterval(tick); return; }
    p += 6 + Math.random() * 6;
    game.ui.showLoading(true, "Booting interdimensional engine…", Math.min(100, p));
    if (p >= 100) {
      clearInterval(tick);
      game.ui.showLoading(false);
      document.getElementById("title-screen").classList.remove("hidden");
    }
  }, 60);
})();

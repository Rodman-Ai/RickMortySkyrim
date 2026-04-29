// Combat: melee swing arc, ranged hitscan, projectiles, shout effects (force push, fireball, slow time).
import * as THREE from "three";
import { sfx } from "./audio.js";
import { ITEMS } from "./data.js";

// Pooled particle system: each particle is a small InstancedMesh entry.
// Keep it simple: a small array of meshes that we reuse. ~150 max alive.
class Particles {
  constructor(scene) {
    this.scene = scene;
    this.list = [];   // {mesh, vx, vy, vz, life, ttl, fade, scaleRate}
  }
  spawn({ x, y, z, color = 0xffaa55, count = 12, speed = 4, life = 0.9, size = 0.18, gravity = 6 }) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
      const m = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 5), mat);
      m.position.set(x, y, z);
      const a = Math.random() * Math.PI * 2, b = (Math.random() - 0.3) * Math.PI * 0.5;
      const v = speed * (0.5 + Math.random() * 0.7);
      this.scene.add(m);
      this.list.push({
        mesh: m, mat,
        vx: Math.cos(a) * Math.cos(b) * v,
        vy: Math.sin(b) * v + speed * 0.6,
        vz: Math.sin(a) * Math.cos(b) * v,
        life: 0, ttl: life * (0.7 + Math.random() * 0.6),
        gravity,
      });
    }
  }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life += dt;
      p.vy -= p.gravity * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const k = 1 - p.life / p.ttl;
      p.mat.opacity = Math.max(0, k);
      if (p.life >= p.ttl) {
        this.scene.remove(p.mesh);
        this.list.splice(i, 1);
      }
    }
  }
}

export class Combat {
  constructor(scene, player, enemyMgr, ui, game) {
    this.scene = scene;
    this.player = player;
    this.enemyMgr = enemyMgr;
    this.ui = ui;
    this.game = game;          // for slow-time control
    this.projectiles = [];     // { mesh, dir, speed, dmg, owner: 'player'|'enemy', life }
    this.fxList = [];          // visual effects with TTL
    this.particles = new Particles(scene);
    this.loot = [];            // active loot pickups in world
  }

  update(dt) {
    // Particles
    this.particles.update(dt);
    // Loot bobbing
    for (const l of this.loot) {
      l.bobT += dt;
      l.mesh.position.y = l.y + 0.6 + Math.sin(l.bobT * 3) * 0.18;
      l.mesh.rotation.y += dt * 1.2;
    }

    // Move projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.mesh.position.addScaledVector(p.dir, p.speed * dt);
      // Fireball trails
      if (p.explodeOnEnd && Math.random() < 0.6) {
        this.particles.spawn({
          x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z,
          color: 0xff8844, count: 1, speed: 0.6, life: 0.4, size: 0.12, gravity: 1
        });
      }
      if (p.owner === "enemy") {
        const dx = this.player.pos.x - p.mesh.position.x;
        const dy = this.player.pos.y - p.mesh.position.y;
        const dz = this.player.pos.z - p.mesh.position.z;
        if (dx * dx + dy * dy + dz * dz < 0.9) {
          this.player.takeDamage(p.dmg);
          this.scene.remove(p.mesh);
          this.projectiles.splice(i, 1);
          continue;
        }
      } else {
        let consumed = false;
        for (const e of this.enemyMgr.list) {
          if (e.dead) continue;
          const ex = e.x, ey = e.y + 1.0, ez = e.z;
          const dx = ex - p.mesh.position.x, dy = ey - p.mesh.position.y, dz = ez - p.mesh.position.z;
          if (dx * dx + dy * dy + dz * dz < (e.hitR + 0.4) * (e.hitR + 0.4)) {
            if (p.explodeOnEnd) {
              this._detonateFireball(p.mesh.position.clone());
            } else {
              e.hurt(p.dmg, p.dir.x * 4, p.dir.z * 4);
              this._spawnHitFX(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z);
              this._creditKill(e);
            }
            this.scene.remove(p.mesh);
            this.projectiles.splice(i, 1);
            consumed = true;
            break;
          }
        }
        if (consumed) continue;
      }
      if (p.life <= 0) {
        if (p.explodeOnEnd) this._detonateFireball(p.mesh.position.clone());
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }

    // FX
    for (let i = this.fxList.length - 1; i >= 0; i--) {
      const f = this.fxList[i];
      f.life -= dt;
      if (f.update) f.update(dt);
      if (f.life <= 0) { this.scene.remove(f.mesh); this.fxList.splice(i, 1); }
    }
  }

  _creditKill(e) {
    if (e.hp > 0) return;
    if (e._credited) return;
    e._credited = true;
    this.player.addXP(e.xp);
    this.player.schmeckles += e.gold;
    sfx.schmeckle();
    // Death particle burst
    this.particles.spawn({
      x: e.x, y: e.y + 1.2, z: e.z,
      color: e.type === "trooper" ? 0xff7733 : e.type === "cromulon" ? 0xddaa44 : 0xc28b88,
      count: 16, speed: 5, life: 1.0, size: 0.18, gravity: 9,
    });
    this._maybeDropLoot(e);
    this.game.onEnemyKilled(e);
  }

  _maybeDropLoot(e) {
    // Bosses and troopers drop more reliably
    let chance = 0.35;
    if (e.boss) chance = 1;
    else if (e.type === "trooper") chance = 0.55;
    if (Math.random() > chance) return;
    const roll = Math.random();
    let kind;
    if (e.boss) kind = "schwiftyPotion";
    else if (roll < 0.4) kind = "healJuice";
    else if (roll < 0.7) kind = "schwiftyPotion";
    else if (roll < 0.9) kind = "schmecklePouch";
    else kind = "szechuanSauce";
    this._spawnLoot(e.x, e.y, e.z, kind);
  }

  _spawnLoot(x, y, z, kind) {
    const colorByKind = { healJuice: 0xff5577, schwiftyPotion: 0x5dffd1, szechuanSauce: 0xc44a2a, schmecklePouch: 0xffd166 };
    const color = colorByKind[kind] || 0xffffff;
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.35, 0), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.5 }));
    m.position.set(x, y + 0.6, z);
    this.scene.add(m);
    this.loot.push({ x, y, z, mesh: m, kind, bobT: Math.random() * 6.28 });
  }

  // Player picks up loot when adjacent. Called from main loop.
  tryPickupLoot(player) {
    for (let i = this.loot.length - 1; i >= 0; i--) {
      const l = this.loot[i];
      const d = Math.hypot(player.pos.x - l.x, player.pos.z - l.z);
      if (d < 1.6) {
        if (l.kind === "schmecklePouch") {
          const amt = 25 + Math.floor(Math.random() * 40);
          player.schmeckles += amt;
          this.ui.toast(`+${amt} schmeckles`);
        } else {
          this.game.inventory.add(l.kind, 1);
          this.ui.toast(`Picked up: ${ITEMS[l.kind]?.name || l.kind}`);
        }
        sfx.pickup();
        this.scene.remove(l.mesh);
        this.loot.splice(i, 1);
      }
    }
  }

  // === PLAYER ATTACKS ===
  playerMelee() {
    const reach = 2.6;
    const fwd = this.player.forward;
    const px = this.player.pos.x, pz = this.player.pos.z;
    const px2 = px + fwd.x * reach * 0.5, pz2 = pz + fwd.z * reach * 0.5;
    const dmg = Math.round((ITEMS.plumbus.dmg) * this.player.buffMult);
    let hit = false;
    for (const e of this.enemyMgr.list) {
      if (e.dead) continue;
      const dx = e.x - px2, dz = e.z - pz2;
      const d = Math.hypot(dx, dz);
      if (d > reach + e.hitR) continue;
      const ang = Math.atan2(e.x - px, e.z - pz);
      const dirAng = Math.atan2(fwd.x, fwd.z);
      let ad = ang - dirAng;
      while (ad > Math.PI) ad -= Math.PI * 2;
      while (ad < -Math.PI) ad += Math.PI * 2;
      if (Math.abs(ad) > 0.7) continue;
      e.hurt(dmg, fwd.x * 6, fwd.z * 6);
      this.ui.spawnDamage(e.x, e.y + 2.2, e.z, dmg, "enemy");
      this.particles.spawn({ x: e.x, y: e.y + 1.4, z: e.z, color: 0xffe066, count: 6, speed: 3, life: 0.5, size: 0.1, gravity: 4 });
      hit = true;
      this._creditKill(e);
    }
    this._spawnSwoosh();
    if (hit) { sfx.enemyHit(); this.player.shake(0.25); }
  }

  playerRanged() {
    const fwd = new THREE.Vector3();
    this.player.camera.getWorldDirection(fwd);
    const origin = this.player.camera.position.clone();
    const dmg = Math.round((ITEMS.plasmaRifle.dmg) * this.player.buffMult);
    this._spawnProjectile(origin, fwd, 50, dmg, "player", 0x97ce4c);
    this.player.shake(0.18);
    // muzzle flash particles in front
    const flashPos = origin.clone().addScaledVector(fwd, 0.6);
    this.particles.spawn({ x: flashPos.x, y: flashPos.y, z: flashPos.z, color: 0x97ce4c, count: 4, speed: 1.5, life: 0.18, size: 0.1, gravity: 0 });
  }

  playerShout(kind) {
    const fwd = new THREE.Vector3();
    this.player.camera.getWorldDirection(fwd);
    if (kind === "wubba") {
      const range = 14, angCos = Math.cos(0.6);
      for (const e of this.enemyMgr.list) {
        if (e.dead) continue;
        const dx = e.x - this.player.pos.x;
        const dz = e.z - this.player.pos.z;
        const dy = (e.y + 1.2) - this.player.pos.y;
        const d = Math.hypot(dx, dy, dz);
        if (d > range) continue;
        const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / Math.max(0.0001, d);
        if (dot < angCos) continue;
        e.hurt(28, fwd.x * 26, fwd.z * 26);
        this.ui.spawnDamage(e.x, e.y + 2.2, e.z, 28, "enemy");
        this._creditKill(e);
      }
      this._spawnConeFX(this.player.pos, fwd, 0xffd166);
      this.player.shake(0.7);
      this.ui.toast("WUBBA LUBBA DUB DUB!");
    } else if (kind === "schwifty") {
      this._spawnProjectile(this.player.camera.position.clone(), fwd, 35, 0, "player", 0xff8844, true);
      this.player.shake(0.4);
      this.ui.toast("Get Schwifty!");
    } else if (kind === "pickle") {
      for (const e of this.enemyMgr.list) e.slowTimer = Math.max(e.slowTimer, 6);
      this.ui.toast("I'M A PICKLEEE!");
      this.game.slowTimeFor(6);
      this._spawnRingFX(this.player.pos);
    }
  }

  // === ENEMY ATTACKS ===
  enemyMelee(e, dmg) {
    const final = this.player.takeDamage(dmg);
    this.ui.spawnDamage(this.player.pos.x, this.player.pos.y + 0.4, this.player.pos.z, final, "player");
  }
  enemyRanged(e, dmg) {
    const origin = new THREE.Vector3(e.x, e.y + 1.6, e.z);
    const target = this.player.pos.clone();
    const dir = target.sub(origin).normalize();
    const speed = e.boss ? 22 : 28;
    this._spawnProjectile(origin, dir, speed, dmg, "enemy", e.boss ? 0xff5588 : 0xff7733);
  }

  // === FX ===
  _spawnProjectile(origin, dir, speed, dmg, owner, color, explodeOnEnd = false) {
    const geo = explodeOnEnd ? new THREE.SphereGeometry(0.5, 12, 8) : new THREE.SphereGeometry(0.18, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(origin).addScaledVector(dir, 1.0);
    if (explodeOnEnd) {
      const light = new THREE.PointLight(color, 2, 10, 2);
      m.add(light);
    }
    this.scene.add(m);
    this.projectiles.push({
      mesh: m,
      dir: dir.clone().normalize(),
      speed,
      dmg,
      owner,
      life: explodeOnEnd ? 1.6 : 2.4,
      explodeOnEnd,
    });
  }

  _detonateFireball(pos) {
    const r = 5, dmgA = 60;
    for (const en of this.enemyMgr.list) {
      if (en.dead) continue;
      const d = Math.hypot(en.x - pos.x, en.z - pos.z);
      if (d < r) {
        en.hurt(dmgA, 0, 0);
        this.ui.spawnDamage(en.x, en.y + 2.2, en.z, dmgA, "enemy");
        this._creditKill(en);
      }
    }
    this._spawnExplosion(pos);
    // Big particle blast
    this.particles.spawn({ x: pos.x, y: pos.y, z: pos.z, color: 0xff9944, count: 30, speed: 8, life: 1.0, size: 0.22, gravity: 6 });
    this.particles.spawn({ x: pos.x, y: pos.y, z: pos.z, color: 0x222222, count: 15, speed: 3, life: 1.6, size: 0.3, gravity: 1 });
    // Brief point light (added to explosion fx so it fades with it)
    const light = new THREE.PointLight(0xff8844, 4, 18, 2);
    light.position.copy(pos);
    this.scene.add(light);
    this.fxList.push({ mesh: light, life: 0.45, update: (dt) => { light.intensity = Math.max(0, light.intensity - dt * 9); } });
    this.player.shake(0.5);
  }

  _spawnSwoosh() {
    const geo = new THREE.RingGeometry(1.2, 1.7, 16, 1, -0.7, 1.4);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffaa, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(this.player.pos).addScaledVector(this.player.forward, 1.6);
    m.lookAt(this.player.pos);
    this.scene.add(m);
    this.fxList.push({ mesh: m, life: 0.18, update: (dt) => { mat.opacity -= dt * 4; } });
  }

  _spawnHitFX(x, y, z) {
    const geo = new THREE.SphereGeometry(0.5, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    this.scene.add(m);
    this.fxList.push({ mesh: m, life: 0.3, update: (dt) => { m.scale.multiplyScalar(1 + dt * 6); mat.opacity -= dt * 3; } });
  }

  _spawnExplosion(pos) {
    const geo = new THREE.SphereGeometry(1.0, 14, 10);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.95 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    this.scene.add(m);
    this.fxList.push({ mesh: m, life: 0.5, update: (dt) => { m.scale.multiplyScalar(1 + dt * 5); mat.opacity -= dt * 2.5; } });
  }

  _spawnConeFX(pos, dir, color) {
    const geo = new THREE.ConeGeometry(4.5, 12, 16, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos).addScaledVector(dir, 7);
    m.position.y += 0.5;
    m.lookAt(pos.clone().addScaledVector(dir, -1));
    m.rotateX(Math.PI / 2);
    this.scene.add(m);
    this.fxList.push({ mesh: m, life: 0.4, update: (dt) => { mat.opacity -= dt * 1.6; m.scale.multiplyScalar(1 + dt * 1.5); } });
  }

  _spawnRingFX(pos) {
    const geo = new THREE.RingGeometry(1.0, 1.4, 32);
    const mat = new THREE.MeshBasicMaterial({ color: 0x97ce4c, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    m.position.y += 0.05;
    m.rotation.x = -Math.PI / 2;
    this.scene.add(m);
    this.fxList.push({ mesh: m, life: 1.2, update: (dt) => { m.scale.multiplyScalar(1 + dt * 4); mat.opacity -= dt * 0.8; } });
  }
}

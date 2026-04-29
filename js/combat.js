// Combat: melee swing arc, ranged hitscan, projectiles, shout effects (force push, fireball, slow time).
import * as THREE from "three";
import { sfx } from "./audio.js";
import { ITEMS } from "./data.js";

export class Combat {
  constructor(scene, player, enemyMgr, ui, game) {
    this.scene = scene;
    this.player = player;
    this.enemyMgr = enemyMgr;
    this.ui = ui;
    this.game = game;          // for slow-time control
    this.projectiles = [];     // { mesh, dir, speed, dmg, owner: 'player'|'enemy', life }
    this.fxList = [];          // visual effects with TTL
  }

  update(dt) {
    // Move projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.mesh.position.addScaledVector(p.dir, p.speed * dt);
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
    this.game.onEnemyKilled(e);
  }

  // === PLAYER ATTACKS ===
  playerMelee() {
    const reach = 2.6;
    const fwd = this.player.forward;
    const px = this.player.pos.x, pz = this.player.pos.z;
    const px2 = px + fwd.x * reach * 0.5, pz2 = pz + fwd.z * reach * 0.5;
    const dmg = (ITEMS.plumbus.dmg) * this.player.buffMult;
    let hit = false;
    for (const e of this.enemyMgr.list) {
      if (e.dead) continue;
      const dx = e.x - px2, dz = e.z - pz2;
      const d = Math.hypot(dx, dz);
      if (d > reach + e.hitR) continue;
      // angle check
      const ang = Math.atan2(e.x - px, e.z - pz);
      const dirAng = Math.atan2(fwd.x, fwd.z);
      let ad = ang - dirAng;
      while (ad > Math.PI) ad -= Math.PI * 2;
      while (ad < -Math.PI) ad += Math.PI * 2;
      if (Math.abs(ad) > 0.7) continue;
      e.hurt(dmg, fwd.x * 6, fwd.z * 6);
      hit = true;
      this._creditKill(e);
    }
    // Show a swoosh fx
    this._spawnSwoosh();
    if (hit) sfx.enemyHit();
  }

  playerRanged() {
    const fwd = new THREE.Vector3();
    this.player.camera.getWorldDirection(fwd);
    const origin = this.player.camera.position.clone();
    const dmg = (ITEMS.plasmaRifle.dmg) * this.player.buffMult;
    this._spawnProjectile(origin, fwd, 50, dmg, "player", 0x97ce4c);
  }

  playerShout(kind) {
    const fwd = new THREE.Vector3();
    this.player.camera.getWorldDirection(fwd);
    if (kind === "wubba") {
      // Force push: cone, knockback + dmg
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
        this._creditKill(e);
      }
      this._spawnConeFX(this.player.pos, fwd, 0xffd166);
      this.ui.toast("WUBBA LUBBA DUB DUB!");
    } else if (kind === "schwifty") {
      // Fireball projectile, AoE on impact
      this._spawnProjectile(this.player.camera.position.clone(), fwd, 35, 0, "player", 0xff8844, true);
      this.ui.toast("Get Schwifty!");
    } else if (kind === "pickle") {
      // Slow time on enemies for 6s
      for (const e of this.enemyMgr.list) e.slowTimer = Math.max(e.slowTimer, 6);
      this.ui.toast("I'M A PICKLEEE!");
      this.game.slowTimeFor(6);
      this._spawnRingFX(this.player.pos);
    }
  }

  // === ENEMY ATTACKS ===
  enemyMelee(e, dmg) {
    this.player.takeDamage(dmg);
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
        this._creditKill(en);
      }
    }
    this._spawnExplosion(pos);
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

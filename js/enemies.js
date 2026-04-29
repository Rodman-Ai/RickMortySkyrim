// Enemy AI: Cronenberg (melee), Federation Trooper (ranged), Cromulon (boss).
import * as THREE from "three";
import { heightAt } from "./world.js";
import { ZONES } from "./data.js";
import { sfx } from "./audio.js";

let _id = 0;

function makeCronenberg() {
  const g = new THREE.Group();
  // Goopy melted body — pinkish blob
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 1), new THREE.MeshLambertMaterial({ color: 0xc28b88, flatShading: true }));
  body.position.y = 1.0;
  // Distort vertices slightly
  const pos = body.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * (0.8 + Math.random() * 0.4), pos.getY(i) * (0.8 + Math.random() * 0.5), pos.getZ(i) * (0.8 + Math.random() * 0.4));
  }
  body.geometry.computeVertexNormals();
  // A second smaller blob
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), new THREE.MeshLambertMaterial({ color: 0xa56b66 }));
  head.position.set(0.4, 1.7, 0);
  // Eye
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffaa }));
  eye.position.set(0.55, 1.85, 0.4);
  g.add(body); g.add(head); g.add(eye);
  return g;
}
function makeTrooper() {
  const g = new THREE.Group();
  // Federation trooper — black uniform, gold helm
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 1.5, 8), new THREE.MeshLambertMaterial({ color: 0x222233 }));
  body.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 8), new THREE.MeshLambertMaterial({ color: 0xc89a3c }));
  head.position.y = 2.1;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0x202020 }));
  visor.position.set(0, 2.15, 0.28);
  const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.9), new THREE.MeshLambertMaterial({ color: 0x444444 }));
  rifle.position.set(0.45, 1.3, 0.35);
  g.add(body); g.add(head); g.add(visor); g.add(rifle);
  return g;
}
function makeMeeseeks() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.6, 8), new THREE.MeshLambertMaterial({ color: 0x4ec0e0 }));
  body.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshLambertMaterial({ color: 0x4ec0e0 }));
  head.position.y = 2.1;
  // Crazy eyes
  for (const sgn of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    e.position.set(0.18 * sgn, 2.2, 0.42);
    g.add(e);
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    p.position.set(0.18 * sgn, 2.2, 0.5);
    g.add(p);
  }
  // Open mouth
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.18, 0.05), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  mouth.position.set(0, 1.95, 0.48);
  g.add(body); g.add(head); g.add(mouth);
  return g;
}
function makeCromulon() {
  const g = new THREE.Group();
  // Giant cosmic head
  const head = new THREE.Mesh(new THREE.SphereGeometry(7, 24, 18), new THREE.MeshLambertMaterial({ color: 0xddaa44, flatShading: true }));
  head.position.y = 7;
  const eye = new THREE.Mesh(new THREE.SphereGeometry(2.4, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  eye.position.set(0, 8, 6.2);
  const pup = new THREE.Mesh(new THREE.SphereGeometry(1.0, 12, 10), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  pup.position.set(0, 8, 8.3);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(6, 1.5, 0.4), new THREE.MeshBasicMaterial({ color: 0x331100 }));
  mouth.position.set(0, 4, 6.6);
  g.add(head); g.add(eye); g.add(pup); g.add(mouth);
  return g;
}

export class Enemy {
  constructor(type, x, z) {
    this.id = ++_id;
    this.type = type;
    this.x = x; this.z = z; this.y = heightAt(x, z);
    this.facing = Math.random() * Math.PI * 2;
    this.attackCD = 0;
    this.flash = 0;
    this.dead = false;
    this.aggro = false;
    this.knockback = new THREE.Vector3();
    this.slowTimer = 0;
    this.searchTimer = 0;

    if (type === "cronenberg") {
      this.mesh = makeCronenberg();
      this.maxHP = 35; this.hp = 35;
      this.speed = 3.5; this.aggroR = 18; this.attackR = 1.8;
      this.dmg = 8; this.atkInt = 1.0;
      this.xp = 25; this.gold = 10;
      this.hitR = 1.0;
    } else if (type === "trooper") {
      this.mesh = makeTrooper();
      this.maxHP = 45; this.hp = 45;
      this.speed = 3.2; this.aggroR = 32; this.attackR = 22;
      this.dmg = 11; this.atkInt = 1.6;
      this.xp = 35; this.gold = 18;
      this.hitR = 0.9;
    } else if (type === "meeseeks") {
      this.mesh = makeMeeseeks();
      this.maxHP = 25; this.hp = 25;
      this.speed = 5.5; this.aggroR = 22; this.attackR = 1.6;
      this.dmg = 6; this.atkInt = 0.6;
      this.xp = 18; this.gold = 6;
      this.hitR = 0.8;
    } else if (type === "cromulon") {
      this.mesh = makeCromulon();
      this.maxHP = 600; this.hp = 600;
      this.speed = 0.5; this.aggroR = 90; this.attackR = 60;
      this.dmg = 22; this.atkInt = 2.4;
      this.xp = 600; this.gold = 800;
      this.hitR = 7;
      this.boss = true;
    }
    this.mesh.position.set(x, this.y, z);
  }

  // Called by combat: enemy was hit
  hurt(amount, kx = 0, kz = 0, slowSec = 0) {
    if (this.dead) return;
    this.hp -= amount;
    this.flash = 0.2;
    this.aggro = true;
    this.searchTimer = 6;
    this.knockback.x += kx; this.knockback.z += kz;
    if (slowSec) this.slowTimer = Math.max(this.slowTimer, slowSec);
    if (this.hp <= 0) this.die();
    else sfx.enemyHit();
  }

  die() {
    this.dead = true;
    this.hp = 0;
    sfx.enemyDie();
  }

  update(dt, player, combat) {
    if (this.dead) {
      // Sink and fade
      this.mesh.position.y -= dt * 1.2;
      this.mesh.rotation.x += dt * 1.5;
      return;
    }

    // Knockback
    this.x += this.knockback.x * dt;
    this.z += this.knockback.z * dt;
    this.knockback.x *= 0.85; this.knockback.z *= 0.85;

    // Slow
    let speedFactor = 1;
    if (this.slowTimer > 0) { speedFactor = 0.3; this.slowTimer -= dt; }

    const dx = player.pos.x - this.x;
    const dz = player.pos.z - this.z;
    const d = Math.hypot(dx, dz);

    // Aggro check
    if (!this.aggro && d < this.aggroR) {
      this.aggro = true; this.searchTimer = 6;
    }
    if (this.aggro && d > this.aggroR * 1.6 && this.searchTimer <= 0) {
      this.aggro = false;
    }
    if (this.searchTimer > 0) this.searchTimer -= dt;

    if (this.aggro && d > 0.001) {
      this.facing = Math.atan2(dx, dz);
      // Move toward / keep distance for ranged
      const desired = this.type === "trooper" ? Math.max(this.attackR * 0.5, 8) : this.attackR * 0.7;
      let moveDir = 0;
      if (d > desired + 0.5) moveDir = 1;
      else if (d < desired - 0.5 && this.type === "trooper") moveDir = -0.6;
      const nx = dx / d, nz = dz / d;
      this.x += nx * this.speed * speedFactor * moveDir * dt;
      this.z += nz * this.speed * speedFactor * moveDir * dt;
    } else {
      // Idle wander
      if (Math.random() < 0.005) this.facing += (Math.random() - 0.5) * 1.0;
      this.x += Math.sin(this.facing) * 0.6 * dt;
      this.z += Math.cos(this.facing) * 0.6 * dt;
    }

    // Snap to terrain
    this.y = heightAt(this.x, this.z);
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.facing;

    // Flash on damage / target highlight
    this.flash = Math.max(0, this.flash - dt);
    const flashColor = this.flash > 0 ? 0xff5577 : (this._highlight ? 0x5dffd1 : 0x000000);
    const flashIntensity = this.flash > 0 ? 1 : (this._highlight ? 0.5 : 0);
    this.mesh.traverse((c) => {
      if (c.material && c.material.emissive !== undefined) {
        c.material.emissive.setHex(flashColor);
        if (c.material.emissiveIntensity !== undefined) c.material.emissiveIntensity = flashIntensity;
      }
    });
    this._highlight = false; // UI re-asserts each frame

    // Cromulon idle wobble
    if (this.boss) this.mesh.position.y += Math.sin(performance.now() * 0.001) * 0.4;

    // Attack
    this.attackCD -= dt;
    if (this.aggro && d < this.attackR && this.attackCD <= 0) {
      this.attackCD = this.atkInt;
      if (this.type === "cronenberg" || this.type === "meeseeks") {
        if (d < this.attackR + 0.3) combat.enemyMelee(this, this.dmg);
      } else if (this.type === "trooper" || this.type === "cromulon") {
        combat.enemyRanged(this, this.dmg);
      }
    }
  }
}

export class EnemyManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
  }
  spawn(type, x, z) {
    const e = new Enemy(type, x, z);
    this.scene.add(e.mesh);
    this.list.push(e);
    return e;
  }
  removeDead() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.dead && e.mesh.position.y < e.y - 4) {
        this.scene.remove(e.mesh);
        this.list.splice(i, 1);
      }
    }
  }
  update(dt, player, combat) {
    for (const e of this.list) e.update(dt, player, combat);
    this.removeDead();
  }

  // Populate world
  populateWorld() {
    // Cronenbergs in the wastes
    const wastes = ZONES.find((z) => z.id === "cronenberg_wastes");
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * wastes.r;
      this.spawn("cronenberg", wastes.cx + Math.cos(a) * r, wastes.cz + Math.sin(a) * r);
    }
    // Troopers — patrolling around the dimension, north of garage
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 60 + Math.random() * 100;
      const x = Math.cos(a) * r, z = Math.sin(a) * r - 40;
      this.spawn("trooper", x, z);
    }
    // Meeseekses around the citadel
    const cit = ZONES.find((z) => z.id === "citadel");
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * cit.r;
      this.spawn("meeseeks", cit.cx + Math.cos(a) * r, cit.cz + Math.sin(a) * r);
    }
    // The Cromulon — one boss
    const can = ZONES.find((z) => z.id === "cromulon_canyon");
    this.spawn("cromulon", can.cx, can.cz);
  }
}

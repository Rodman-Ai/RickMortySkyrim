// First-person player controller. Camera-driven; movement, jumping, gravity. Stats and shouts live here.
import * as THREE from "three";
import { heightAt } from "./world.js";
import { sfx } from "./audio.js";

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 7;
const SPRINT_MULT = 1.7;
const JUMP_VEL = 9;
const GRAVITY = 24;

// Polygon counts boosted ~5x on the viewmodel weapons.
function buildPlumbusModel() {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.45, 22, 4), new THREE.MeshLambertMaterial({ color: 0x8a5a3a }));
  handle.position.set(0, -0.05, 0);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.18, 8, 18), new THREE.MeshLambertMaterial({ color: 0xc77f6c, flatShading: true }));
  body.position.set(0, 0.18, 0);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 22, 18), new THREE.MeshLambertMaterial({ color: 0x9c5544 }));
  knob.position.set(0, 0.35, 0);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 22, 18), new THREE.MeshLambertMaterial({ color: 0xfdd6b5 }));
  hand.position.set(0, -0.3, 0);
  g.add(handle); g.add(body); g.add(knob); g.add(hand);
  return g;
}
function buildPlasmaRifleModel() {
  const g = new THREE.Group();
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.5, 3, 3, 6), new THREE.MeshLambertMaterial({ color: 0x444455 }));
  stock.position.set(0, -0.05, -0.05);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.55, 22, 4), new THREE.MeshLambertMaterial({ color: 0x666677 }));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.02, 0.0, 0.32);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.08, 22, 2), new THREE.MeshBasicMaterial({ color: 0x97ce4c }));
  tip.rotation.x = Math.PI / 2;
  tip.position.set(0.02, 0.0, 0.6);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.1, 3, 4, 3), new THREE.MeshLambertMaterial({ color: 0x222233 }));
  grip.position.set(0, -0.18, 0.05);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 22, 18), new THREE.MeshLambertMaterial({ color: 0xfdd6b5 }));
  hand.position.set(0, -0.28, 0.05);
  g.add(stock); g.add(barrel); g.add(tip); g.add(grip); g.add(hand);
  return g;
}

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, EYE_HEIGHT, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.onGround = true;

    // Stats
    this.maxHP = 100; this.hp = 100;
    this.maxMP = 100; this.mp = 100;
    this.maxST = 100; this.st = 100;
    this.level = 1; this.xp = 0; this.xpToNext = 100;
    this.schmeckles = 0;

    // Equipment
    this.equipped = { melee: "plumbus", ranged: null, head: null, body: null };
    this.attackCooldown = 0;
    this.rangedCooldown = 0;
    this.attackAnim = 0;       // 0..1 swing animation
    this.attackKind = "melee";

    // Shout cooldowns (seconds)
    this.shoutCD = [0, 0, 0];
    this.shoutMax = [10, 14, 22];
    this.shoutCost = [25, 40, 55];

    // Damage flash & szechuan buff
    this.hitFlash = 0;
    this.buffTimer = 0;
    this.buffMult = 1;

    // For interaction/raycast
    this.forward = new THREE.Vector3();

    this._stepTimer = 0;

    // First-person viewmodel rig — child of camera, lives in screen space.
    this.viewmodel = new THREE.Group();
    this.viewmodel.position.set(0.32, -0.32, -0.55);
    this.viewmodel.rotation.set(0, -0.05, 0);
    this.camera.add(this.viewmodel);
    if (!this.camera.parent) {
      // Camera hasn't been added to a scene yet; the renderer still draws it,
      // but children only render when traversed via the scene. We add it later
      // from main once the scene exists. For now, a no-op.
    }
    this._weaponMeshes = {
      plumbus: buildPlumbusModel(),
      plasmaRifle: buildPlasmaRifleModel(),
    };
    this._currentWeaponKey = null;
    this._shake = new THREE.Vector3();
    this._shakeT = 0;
  }

  applyLook(dx, dy) {
    this.yaw -= dx;
    this.pitch -= dy;
    const lim = Math.PI / 2 - 0.05;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;
  }

  update(dt, input, world, combat) {
    // Look
    this.applyLook(input.lookX, input.lookY);

    // Forward and right vectors based on yaw only (no pitch for movement)
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    this.forward.copy(fwd);

    // Movement
    let speed = WALK_SPEED;
    let sprinting = input.sprint && this.st > 5 && (input.moveX !== 0 || input.moveZ !== 0);
    if (sprinting) { speed *= SPRINT_MULT; this.st -= 18 * dt; }
    else { this.st = Math.min(this.maxST, this.st + 14 * dt); }

    const move = new THREE.Vector3();
    move.addScaledVector(fwd, -input.moveZ);
    move.addScaledVector(right, input.moveX);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

    this.vel.x = move.x;
    this.vel.z = move.z;

    // Jump
    if (input.jump && this.onGround) {
      this.vel.y = JUMP_VEL; this.onGround = false; sfx.jump();
    }

    // Gravity
    this.vel.y -= GRAVITY * dt;

    // Integrate
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;

    // Collide with terrain
    const groundY = heightAt(this.pos.x, this.pos.z) + EYE_HEIGHT;
    if (this.pos.y <= groundY) {
      this.pos.y = groundY;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // Collide with props (cylindrical or AABB)
    const PR = 0.4; // player radius for AABB inflation
    for (const p of world.props) {
      if (p.type === "portal") continue;
      if (p.hitAABB) {
        const a = p.hitAABB;
        if (this.pos.x > a.minX - PR && this.pos.x < a.maxX + PR &&
            this.pos.z > a.minZ - PR && this.pos.z < a.maxZ + PR) {
          const left  = this.pos.x - (a.minX - PR);
          const right = (a.maxX + PR) - this.pos.x;
          const back  = this.pos.z - (a.minZ - PR);
          const front = (a.maxZ + PR) - this.pos.z;
          const m = Math.min(left, right, back, front);
          if      (m === left)  this.pos.x = a.minX - PR;
          else if (m === right) this.pos.x = a.maxX + PR;
          else if (m === back)  this.pos.z = a.minZ - PR;
          else                  this.pos.z = a.maxZ + PR;
        }
        continue;
      }
      const dx = this.pos.x - p.x, dz = this.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      const minD = p.hitR + 0.5;
      if (d < minD && d > 0.001) {
        const push = (minD - d);
        this.pos.x += (dx / d) * push;
        this.pos.z += (dz / d) * push;
      }
    }

    // World bounds
    const lim = 295;
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x));
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z));

    // Footsteps when moving
    if (this.onGround && (Math.abs(this.vel.x) + Math.abs(this.vel.z)) > 1.5) {
      this._stepTimer -= dt * (sprinting ? 1.6 : 1.0);
      if (this._stepTimer <= 0) { sfx.step(); this._stepTimer = 0.45; }
    }

    // Apply pose to camera
    this.camera.position.copy(this.pos);
    // little head bob
    if (this.onGround) {
      const bob = Math.sin(performance.now() * 0.012 * (sprinting ? 1.6 : 1.0)) * 0.05 * (move.length() > 0 ? 1 : 0);
      this.camera.position.y += bob;
    }
    // Camera shake (decays)
    if (this._shakeT > 0) {
      this._shakeT = Math.max(0, this._shakeT - dt * 4);
      const k = this._shakeT;
      this.camera.position.x += (Math.random() - 0.5) * 0.18 * k;
      this.camera.position.y += (Math.random() - 0.5) * 0.18 * k;
    }
    const rotEuler = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(rotEuler);

    // Viewmodel — swap to current weapon and animate
    this._updateViewmodel(dt, move.length() > 0, sprinting);

    // Regen mana
    this.mp = Math.min(this.maxMP, this.mp + 6 * dt);
    if (this.hp < this.maxHP) this.hp = Math.min(this.maxHP, this.hp + 1.5 * dt);

    // Cooldowns
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.rangedCooldown = Math.max(0, this.rangedCooldown - dt);
    this.attackAnim = Math.max(0, this.attackAnim - dt * 4);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.buffTimer = Math.max(0, this.buffTimer - dt);
    if (this.buffTimer <= 0) this.buffMult = 1;
    for (let i = 0; i < 3; i++) this.shoutCD[i] = Math.max(0, this.shoutCD[i] - dt);

    // Attacks
    if (input.melee && this.attackCooldown <= 0 && this.st > 8) {
      this.attackCooldown = 0.55;
      this.attackAnim = 1;
      this.attackKind = "melee";
      this.st -= 8;
      sfx.slash();
      combat.playerMelee();
    }
    if (input.ranged && this.rangedCooldown <= 0 && this.equipped.ranged) {
      this.rangedCooldown = 0.65;
      this.attackAnim = 1;
      this.attackKind = "ranged";
      sfx.plasma();
      combat.playerRanged();
    }

    // Shouts
    if (input.shout1) this._castShout(0, "wubba", combat);
    if (input.shout2) this._castShout(1, "schwifty", combat);
    if (input.shout3) this._castShout(2, "pickle", combat);
  }

  _castShout(slot, kind, combat) {
    if (this.shoutCD[slot] > 0) return;
    if (this.mp < this.shoutCost[slot]) return;
    this.mp -= this.shoutCost[slot];
    this.shoutCD[slot] = this.shoutMax[slot];
    sfx[`shout${slot + 1}`]();
    combat.playerShout(kind);
  }

  _updateViewmodel(dt, moving, sprinting) {
    const desiredKey = this.attackKind === "ranged" && this.equipped.ranged
      ? this.equipped.ranged
      : (this.equipped.melee || "plumbus");
    if (desiredKey !== this._currentWeaponKey) {
      // swap mesh
      if (this._currentMesh) this.viewmodel.remove(this._currentMesh);
      const mesh = this._weaponMeshes[desiredKey] || this._weaponMeshes.plumbus;
      this.viewmodel.add(mesh);
      this._currentMesh = mesh;
      this._currentWeaponKey = desiredKey;
    }
    const t = performance.now() * 0.001;
    // sway with movement
    const swayX = Math.sin(t * (sprinting ? 11 : 6)) * (moving ? 0.05 : 0.012);
    const swayY = Math.cos(t * (sprinting ? 22 : 12)) * (moving ? 0.04 : 0.008);
    // attack animation: melee swings forward+rotate, ranged recoils
    const a = this.attackAnim;
    if (this.attackKind === "ranged") {
      this.viewmodel.position.set(0.32 + swayX, -0.32 + swayY, -0.55 + a * 0.18);
      this.viewmodel.rotation.set(-a * 0.4, -0.05, 0);
    } else {
      this.viewmodel.position.set(0.32 + swayX, -0.32 + swayY, -0.55);
      this.viewmodel.rotation.set(-a * 0.6, -0.05 + a * 0.6, a * 0.7);
    }
  }

  shake(amount = 1) { this._shakeT = Math.min(1.4, this._shakeT + amount); }

  takeDamage(amount) {
    let def = 0;
    if (this.equipped.head) def += 8;
    if (this.equipped.body) def += 14;
    const final = Math.max(1, amount - def);
    this.hp -= final;
    this.hitFlash = 0.4;
    this.shake(0.6);
    sfx.hit();
    if (this.hp < 0) this.hp = 0;
    return final;
  }

  addXP(n) {
    this.xp += n;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level += 1;
      this.xpToNext = Math.floor(this.xpToNext * 1.4);
      this.maxHP += 10; this.hp = this.maxHP;
      this.maxMP += 5; this.mp = this.maxMP;
      this.maxST += 5; this.st = this.maxST;
    }
  }
}

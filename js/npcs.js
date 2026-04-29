// NPCs: simple humanoid figures placed in world. Triggered via interact range.
import * as THREE from "three";
import { heightAt } from "./world.js";
import { NPCS } from "./data.js";

function makeNPC(npc) {
  // Polygon counts boosted ~5x: cylinder radial 8→18 + 4 height segs;
  // spheres width/height 12,10 → 28,22 (and 12,8 → 28,18); cone 6 → 24; eyes 6,6 → 14,14.
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 1.4, 18, 4), new THREE.MeshLambertMaterial({ color: npc.color || 0xffaa88 }));
  body.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 28, 22), new THREE.MeshLambertMaterial({ color: 0xfdd6b5 }));
  head.position.y = 2.0;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.38, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: npc.hairColor || 0x553322 }));
  hair.position.y = 2.05;
  for (const sx of [-0.12, 0.12]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 14), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    e.position.set(sx, 2.05, 0.3);
    g.add(e);
  }
  if (npc.id === "birdperson") {
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 24), new THREE.MeshLambertMaterial({ color: 0xddaa55 }));
    beak.position.set(0, 1.95, 0.45);
    beak.rotation.x = Math.PI / 2;
    g.add(beak);
    head.material.color.setHex(0x664433);
  }
  g.add(body); g.add(head); g.add(hair);
  return g;
}

export class NPCManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    for (const def of NPCS) {
      const m = makeNPC(def);
      const [x, _y, z] = def.pos;
      m.position.set(x, heightAt(x, z), z);
      // Floating "!" indicator
      const ind = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
      ind.position.y = 2.8;
      m.add(ind);
      def._mesh = m;
      def._ind = ind;
      def._x = x; def._z = z;
      this.scene.add(m);
      this.list.push(def);
    }
  }
  update(dt, player, questLog) {
    for (const n of this.list) {
      // Bob indicator if NPC has any pending dialogue
      const hasOffer = this._hasOffer(n, questLog);
      n._ind.visible = hasOffer;
      n._ind.position.y = 2.8 + Math.sin(performance.now() * 0.003 + n._x) * 0.15;
      // Face player softly
      const dx = player.pos.x - n._x, dz = player.pos.z - n._z;
      n._mesh.rotation.y = Math.atan2(dx, dz);
    }
  }
  _hasOffer(n, questLog) {
    // Has new quest to give OR a quest ready to turn in
    if (n.dialogue.start.options.some((o) => o.give && !questLog.has(o.give))) return true;
    for (const qid in questLog.quests) {
      const q = questLog.quests[qid];
      if (q.done && q.def.next?.npc === n.id) return true;
    }
    return false;
  }
  // Find an NPC within interactRange of player
  nearestInRange(player, range = 2.5) {
    let best = null, bd = Infinity;
    for (const n of this.list) {
      const d = Math.hypot(player.pos.x - n._x, player.pos.z - n._z);
      if (d < range && d < bd) { bd = d; best = n; }
    }
    return best;
  }
}

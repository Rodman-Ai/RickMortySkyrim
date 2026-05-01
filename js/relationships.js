// NPC Affinity (#42). Hearts 0-10. Each heart costs 100 affinity points.
// Daily talk +5, gift +30/-40/+5/+60 by tier.
import { NPC_GIFTS } from "./data.js";

const HEART_COST = 100;

export class Relationships {
  constructor() {
    this.affinity = {};         // npcId -> int 0..1000
    this.giftedToday = {};      // npcId -> dateString
    this.talkedToday = {};      // npcId -> dateString
    this.dayKey = "";
  }

  hearts(npcId) {
    return Math.min(10, Math.floor((this.affinity[npcId] || 0) / HEART_COST));
  }

  add(npcId, n) {
    this.affinity[npcId] = Math.max(0, Math.min(1000, (this.affinity[npcId] || 0) + n));
  }

  // Called on dialogue open. Awards daily talk bonus, returns true if awarded.
  onTalk(npcId, today) {
    if (this.talkedToday[npcId] === today) return false;
    this.talkedToday[npcId] = today;
    this.add(npcId, 5);
    return true;
  }

  // Try to give a gift today. Returns { ok, tier, delta }.
  giveGift(npcId, itemKey, today) {
    if (this.giftedToday[npcId] === today) return { ok: false, reason: "already" };
    const table = NPC_GIFTS[npcId] || {};
    let tier = "neutral", delta = 5;
    if ((table.loved || []).includes(itemKey)) { tier = "loved"; delta = 60; }
    else if ((table.liked || []).includes(itemKey)) { tier = "liked"; delta = 30; }
    else if ((table.hated || []).includes(itemKey)) { tier = "hated"; delta = -40; }
    this.giftedToday[npcId] = today;
    this.add(npcId, delta);
    return { ok: true, tier, delta };
  }

  serialize() {
    return { affinity: { ...this.affinity }, giftedToday: { ...this.giftedToday }, talkedToday: { ...this.talkedToday } };
  }
  load(state) {
    if (!state) return;
    this.affinity = state.affinity || {};
    this.giftedToday = state.giftedToday || {};
    this.talkedToday = state.talkedToday || {};
  }
}

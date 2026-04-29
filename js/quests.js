// Quest tracking. Listens to kill/pickup events and drives dialogue completion nodes.
import { QUESTS } from "./data.js";

export class QuestLog {
  constructor() {
    this.quests = {};      // id -> { def, progress: [{count}], done, turnedIn }
    this.active = null;     // id of tracked quest
  }

  has(id) { return !!this.quests[id]; }

  give(id) {
    if (this.quests[id]) return;
    const def = QUESTS[id];
    if (!def) return;
    this.quests[id] = {
      def,
      progress: def.objectives.map((_) => ({ count: 0 })),
      done: false,
      turnedIn: false,
    };
    this.active = id;
  }

  finishTurnIn(id) {
    if (!this.quests[id]) return;
    this.quests[id].turnedIn = true;
    this.quests[id].done = true;
    if (this.active === id) {
      const next = Object.keys(this.quests).find((k) => this.quests[k].done && !this.quests[k].turnedIn);
      this.active = next || null;
    }
  }

  onKill(targetType) {
    let any = false;
    for (const id in this.quests) {
      const q = this.quests[id];
      if (q.done) continue;
      q.def.objectives.forEach((o, i) => {
        if (o.type === "kill" && o.target === targetType && q.progress[i].count < o.count) {
          q.progress[i].count += 1;
          any = true;
        }
      });
      this._checkComplete(q);
    }
    return any;
  }

  onPickup(itemKey) {
    for (const id in this.quests) {
      const q = this.quests[id];
      if (q.done) continue;
      q.def.objectives.forEach((o, i) => {
        if (o.type === "pickup" && o.target === itemKey && q.progress[i].count < o.count) {
          q.progress[i].count += 1;
        }
      });
      this._checkComplete(q);
    }
  }

  _checkComplete(q) {
    let all = true;
    q.def.objectives.forEach((o, i) => {
      if (q.progress[i].count < o.count) all = false;
    });
    if (all && !q.done) q.done = true;
  }

  // Returns NPC id+node if a turn-in node should fire
  pendingTurnIn(npcId) {
    for (const id in this.quests) {
      const q = this.quests[id];
      if (q.done && !q.turnedIn && q.def.next?.npc === npcId) {
        return { questId: id, node: q.def.next.node };
      }
    }
    return null;
  }

  serialize() {
    return { quests: Object.fromEntries(Object.entries(this.quests).map(([k, v]) => [k, { progress: v.progress, done: v.done, turnedIn: v.turnedIn }])), active: this.active };
  }
  load(state) {
    this.quests = {};
    if (!state) return;
    for (const k in state.quests) {
      const def = QUESTS[k];
      if (!def) continue;
      const v = state.quests[k];
      this.quests[k] = { def, progress: v.progress, done: v.done, turnedIn: v.turnedIn };
    }
    this.active = state.active;
  }
}

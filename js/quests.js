// Quest tracking. Listens to kill/pickup events and drives dialogue completion nodes.
import { QUESTS, RADIANT_TEMPLATES } from "./data.js";

let _radiantSerial = 0;

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

  // Generate one radiant quest from RADIANT_TEMPLATES; returns the entry.
  giveRadiant() {
    const tpl = RADIANT_TEMPLATES[Math.floor(Math.random() * RADIANT_TEMPLATES.length)];
    if (!tpl) return null;
    const count = tpl.min + Math.floor(Math.random() * (tpl.max - tpl.min + 1));
    const reward = tpl.schmeckles[0] + Math.floor(Math.random() * (tpl.schmeckles[1] - tpl.schmeckles[0] + 1));
    const id = `rad_${++_radiantSerial}_${Date.now() % 100000}`;
    const def = {
      title: tpl.title,
      text: `Bounty: defeat ${count} ${tpl.target}s. Reward: ${reward} schmeckles.`,
      objectives: [{ type: "kill", target: tpl.target, count }],
      reward: { schmeckles: reward },
      radiant: true,
    };
    this.quests[id] = {
      def,
      progress: [{ count: 0 }],
      done: false,
      turnedIn: false,
      _autoTurnIn: true,
    };
    this.active = id;
    return { id, def };
  }

  // Auto-turn-in radiants on completion (no NPC turn-in node).
  _checkComplete(q) {
    let all = true;
    q.def.objectives.forEach((o, i) => {
      if (q.progress[i].count < o.count) all = false;
    });
    if (all && !q.done) {
      q.done = true;
      if (q._autoTurnIn) {
        q.turnedIn = true;
      }
    }
  }

  serialize() {
    return {
      quests: Object.fromEntries(Object.entries(this.quests).map(([k, v]) => [k, {
        progress: v.progress, done: v.done, turnedIn: v.turnedIn,
        radiantDef: v.def.radiant ? v.def : undefined,
      }])),
      active: this.active,
    };
  }
  load(state) {
    this.quests = {};
    if (!state) return;
    for (const k in state.quests) {
      const v = state.quests[k];
      const def = v.radiantDef || QUESTS[k];
      if (!def) continue;
      this.quests[k] = { def, progress: v.progress, done: v.done, turnedIn: v.turnedIn, _autoTurnIn: !!v.radiantDef };
    }
    this.active = state.active;
  }
}

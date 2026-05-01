// Achievement tracker (#91). Unlocks survive in localStorage cross-save.
import { ACHIEVEMENTS } from "./data.js";

const STORAGE_KEY = "wldd_cheevs_v1";

export class Achievements {
  constructor() {
    this.unlocked = new Set();
    this.weatherSeen = new Set();
    this.killCount = 0;
    this.sellCount = 0;
    this.shoutsUsedThisSession = new Set();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (raw && Array.isArray(raw.unlocked)) for (const id of raw.unlocked) this.unlocked.add(id);
    } catch {}
  }
  _save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ unlocked: Array.from(this.unlocked) })); } catch {}
  }

  has(id) { return this.unlocked.has(id); }
  list() {
    return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: this.unlocked.has(a.id) }));
  }

  unlock(id, ui) {
    if (this.unlocked.has(id)) return false;
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (!def) return false;
    this.unlocked.add(id);
    this._save();
    if (ui) ui.cheevToast(def);
    if (this.unlocked.size === 15) this.unlock("achiever", ui);
    return true;
  }

  // Event hooks called from gameplay.
  onEnemyKilled(e, ui) {
    this.killCount++;
    this.unlock("first_blood", ui);
    if (this.killCount >= 10)  this.unlock("ten_kills", ui);
    if (this.killCount >= 100) this.unlock("hundred_kills", ui);
    if (e.type === "cromulon") this.unlock("boss_cromulon", ui);
  }
  onLoot(ui)        { this.unlock("first_loot", ui); }
  onShout(idx, ui)  { this.unlock("first_shout", ui); this.shoutsUsedThisSession.add(idx);
                      if (this.shoutsUsedThisSession.size >= 3) this.unlock("all_shouts", ui); }
  onQuestDone(id, ui) {
    this.unlock("first_quest", ui);
    if (id === "boss_cromulon") this.unlock("main_done", ui);
  }
  onSchmeckles(amt, ui) { if (amt >= 1000) this.unlock("rich", ui); }
  onPurchase(ui)        { this.unlock("merchant", ui); }
  onSell(ui)            { this.sellCount++; if (this.sellCount >= 10) this.unlock("thrifty", ui); }
  onShrine(ui)          { this.unlock("shrine", ui); }
  onPortal(ui)          { this.unlock("portal", ui); }
  onLevel(level, ui)    { if (level >= 5) this.unlock("level_5", ui); if (level >= 10) this.unlock("level_10", ui); }
  onHearts(allMaxed, ui) { if (allMaxed) this.unlock("rich_friend", ui); }
  onMarriage(ui)        { this.unlock("marriage", ui); }
  onWordWall(ui)        { this.unlock("word_wall", ui); }
  onWeather(id, ui) {
    this.weatherSeen.add(id);
    if (this.weatherSeen.size >= 5) this.unlock("all_weather", ui);
  }
}

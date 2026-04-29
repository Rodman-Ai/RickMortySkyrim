// Inventory: list of {key, count}. Equip/use logic.
import { ITEMS } from "./data.js";

export class Inventory {
  constructor() { this.items = {}; }
  add(key, count = 1) {
    if (!ITEMS[key]) return;
    this.items[key] = (this.items[key] || 0) + count;
  }
  remove(key, count = 1) {
    if (!this.items[key]) return false;
    this.items[key] -= count;
    if (this.items[key] <= 0) delete this.items[key];
    return true;
  }
  has(key, count = 1) { return (this.items[key] || 0) >= count; }
  list() {
    return Object.entries(this.items).map(([k, c]) => ({ key: k, count: c, def: ITEMS[k] }));
  }
  serialize() { return { ...this.items }; }
  load(state) { this.items = state || {}; }
}

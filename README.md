# Wubba Lubba Dub Dawn

> *"Get in, Morty. We're going to slay some Cromulons."*

A browser-based Skyrim clone, except every fantasy archetype has been swapped for a **Rick and Morty** universe analog. First-person 3D open world, melee + ranged combat, three Burps (shouts), quests, NPCs, day/night, and a persistent save — all running in vanilla JavaScript + [Three.js] and deployed as static files to **GitHub Pages**.

Plays on **desktop** (mouse + keyboard) and **mobile** (virtual joystick + touch buttons).

[![Deploy to GitHub Pages](https://github.com/Rodman-Ai/RickMortySkyrim/actions/workflows/deploy.yml/badge.svg)](https://github.com/Rodman-Ai/RickMortySkyrim/actions/workflows/deploy.yml)

---

## Play it

After the GitHub Actions workflow runs, the game is live at:

`https://<your-org>.github.io/RickMortySkyrim/`

Locally:

```bash
# Anything that serves static files works.
python3 -m http.server 8000
# then open http://127.0.0.1:8000
```

> The game uses ES modules + an importmap to load Three.js from a CDN — there is **no build step**.

---

## The Lore

The Galactic Federation has occupied dimension C-137. The Council of Ricks is fractured. Cromulons stir in the canyon to the south. You — a wandering interdimensional vagrant — are tasked by Rick with a job no one else will take: clean it up before Jerry ruins everything (again).

### The Map of C-137
- **Smith Garage** — peaceful village hub. Talk to Rick, Morty, and Jerry.
- **Cronenberg Wastes** — eastward badlands swarming with mutated humanoids.
- **Citadel of Ricks** — northwest, occupied by feral Mr. Meeseekses.
- **Cromulon Canyon** — southeast, home of the boss Cromulon. *Show me what ya got.*
- **Birdperson's Peak** — northwest mountains, home of Birdperson.

### Skyrim → Rick & Morty mapping

| Skyrim | Wubba Lubba Dub Dawn |
| --- | --- |
| Iron Sword | **Plumbus** |
| Bow / Magic | **Plasma Rifle** |
| Mana | **Schwifty** |
| Gold | **Schmeckles** |
| Fus Ro Dah | **Wubba Lubba Dub Dub** (force push) |
| Yol Toor Shul | **Get Schwifty** (fireball) |
| Tiid Klo Ul | **Pickle Time** (slow time) |
| Draugr | **Cronenbergs** |
| Bandits | **Galactic Federation Troopers** |
| Wolves | **Mr. Meeseekses (gone wrong)** |
| Dragons | **Cromulons** |
| Health potion | **Concentrated Dark Matter Juice** |
| Soul gem | **Meeseeks Box** |
| "Fus Ro Dah!" | "Wubba lubba dub dub!" |

---

## Controls

### Desktop
| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Look | Mouse (click canvas to lock) |
| Sprint | `Shift` |
| Jump | `Space` |
| Plumbus (melee) | `Left Click` |
| Plasma Rifle (ranged) | `Right Click` or `F` |
| Burp 1 — Wubba Lubba Dub Dub | `1` |
| Burp 2 — Get Schwifty | `2` |
| Burp 3 — Pickle Time | `3` |
| Talk / Interact | `E` |
| Inventory & Quests | `Tab` |
| Map | `M` |
| Pause | `Esc` |

### Mobile
- **Left half** of the screen — virtual joystick (push past 85% to sprint).
- **Right half** — drag to look.
- **Bottom-right buttons** — `⤒` jump, `👋` interact, `⚔` melee, `🔫` plasma.
- **Stack on right** — `1` `2` `3` Burps.
- **Top-right `☰`** — pause / menu.

---

## Game Systems

- **Stats**: HP, Schwifty (mana), Stamina, level/XP, Schmeckles.
- **Combat**: melee swing arc, ranged hitscan-style plasma projectiles with knockback, AoE shouts.
- **Three Burps (shouts)** — each on a separate cooldown:
  - **Wubba Lubba Dub Dub** — cone-shaped force push, 28 dmg + heavy knockback.
  - **Get Schwifty** — fireball projectile with 5-unit AoE, 60 dmg.
  - **Pickle Time** — slows all enemies for 6 s and dilates time.
- **Enemies**: Cronenbergs (melee blob), Federation Troopers (ranged plasma), Mr. Meeseekses (fast melee), and the **Cromulon** boss.
- **Quests** (driven by the dialogue tree):
  - *Show Me What Ya Got* — Rick: kill 5 Federation Troopers.
  - *Aw Geez, Cronenbergs* — Morty: clear 6 Cronenbergs.
  - *Jerry's Plumbus* — Jerry: find his lost Plumbus in the Wastes.
  - *Show Them What You've Got* — Birdperson: defeat the Cromulon.
- **NPCs**: Rick, Morty, Jerry, Birdperson — each with quest hooks and turn-in dialogue.
- **World**: 600×600 procedural heightmap with 5 biome zones, scattered alien-colored trees, rocks, huts, glowing portals (warp between zones), and shrines (heal + save + respawn point).
- **Day/night cycle** — ~4-minute full day, sky tint, sun sweep.
- **Save/Load**: autosave every 30 s and on shrine prayer; persisted to `localStorage`.
- **Procedural audio**: zero external assets — all sound generated with WebAudio so the game stays a single static deploy.

---

## Architecture

```
index.html          ← entry point, importmap for Three.js, all UI markup
styles.css          ← HUD, menus, mobile virtual controls
js/main.js          ← Game class, main loop, save/load, boot
js/world.js         ← terrain heightmap, props, sky, day/night
js/player.js        ← first-person player controller, stats, shouts
js/enemies.js       ← Cronenberg, Trooper, Meeseeks, Cromulon AI
js/combat.js        ← projectiles, melee arc, shout effects, FX
js/npcs.js          ← NPC meshes, interact range, "!" indicators
js/quests.js        ← quest log, kill/pickup tracking, turn-in flow
js/inventory.js     ← items + equip/use logic
js/data.js          ← items, zones, NPCs, dialogue trees, quests, lore
js/controls.js      ← unified keyboard / mouse / pointer-lock / touch input
js/ui.js            ← HUD bars, dialogue, menu tabs, minimap, toast
js/audio.js         ← procedural WebAudio SFX
.github/workflows/deploy.yml   ← GitHub Pages deploy
```

The game loop is in `js/main.js#Game._loop`. Each tick:
1. Poll input (keyboard, mouse, joystick, touch).
2. If menu/dialogue is open, render and skip the simulation step.
3. Otherwise update player → enemies → combat (projectiles & FX) → NPCs → world (day/night).
4. Update HUD, autosave every 30 s.

---

## Deploy to GitHub Pages

The workflow at `.github/workflows/deploy.yml` is triggered on push to `main` (and on this feature branch). It uploads the repo root as a Pages artifact and deploys.

1. Push to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or merge this feature branch). Pages goes live at `https://<owner>.github.io/<repo>/`.

The repo deploys as-is — there is no build step, no bundler, no node_modules.

---

## Tips

- Pray at a **golden ring shrine** to heal and save. Each shrine you visit becomes your respawn point.
- **Portals** at zone centers warp you to the next zone (much faster than running).
- **Szechuan Sauce** gives a +20% damage buff for 30 s — save it for the Cromulon.
- The **Meeseeks Box** instantly nukes the nearest enemy. Don't spam it. Existence is pain.
- The Cromulon hits hard and shoots fast — kite him, use Pickle Time, then Get Schwifty for the AoE.

---

## Credits & Notes

This is a fan project. *Rick and Morty* is © Adult Swim / Cartoon Network. *The Elder Scrolls V: Skyrim* is © Bethesda. No assets from either property are bundled — all art is procedurally generated low-poly, all sound is procedurally synthesized via WebAudio.

Built with [Three.js].

[Three.js]: https://threejs.org/

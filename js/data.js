// Game data — items, NPCs, quests, dialogue. Keeping it data-driven.

export const ITEMS = {
  plumbus: { name: "Plumbus", desc: "Everyone has one. Bonks Cronenbergs.", type: "weapon", slot: "melee", dmg: 18, icon: "🥒" },
  plasmaRifle: { name: "Plasma Rifle", desc: "Federation surplus. Burp.", type: "weapon", slot: "ranged", dmg: 28, icon: "🔫" },
  portalGun: { name: "Portal Gun", desc: "Don't lose this. Seriously.", type: "key", icon: "🌀" },
  meeseeksBox: { name: "Meeseeks Box", desc: "I'm Mr. Meeseeks, look at me!", type: "consume", effect: "summon", icon: "📦" },
  schwiftyPotion: { name: "Schwifty Tonic", desc: "Restores 50 Schwifty.", type: "consume", effect: "mp", value: 50, icon: "🧪" },
  healJuice: { name: "Concentrated Dark Matter Juice", desc: "Restores 60 HP.", type: "consume", effect: "hp", value: 60, icon: "🥤" },
  szechuanSauce: { name: "Szechuan Sauce", desc: "9 seasons in the making. +20% damage briefly.", type: "consume", effect: "buff", value: 20, icon: "🥫" },
  birdpersonHelm: { name: "Helm of Birdperson", desc: "In bird culture, helmets are protection.", type: "armor", slot: "head", def: 8, icon: "🪶" },
  pickleArmor: { name: "Pickle Plate", desc: "I turned myself into a pickle!", type: "armor", slot: "body", def: 14, icon: "🥒" },
  schmeckles: { name: "Schmeckles", desc: "Universally accepted (in this universe).", type: "currency", icon: "🪙" },
};

// Zone definitions (radius positions on the world map; world is ~600x600 around origin)
export const ZONES = [
  { id: "smith_garage",     name: "Smith Garage",        cx:    0, cz:    0, r: 60, color: 0x6c8d4a },
  { id: "cronenberg_wastes",name: "Cronenberg Wastes",   cx:  180, cz:  120, r: 90, color: 0x7a5a3a },
  { id: "citadel",          name: "Citadel of Ricks",    cx: -180, cz: -160, r: 80, color: 0x4a6c8d },
  { id: "cromulon_canyon",  name: "Cromulon Canyon",     cx:  140, cz: -200, r: 70, color: 0x8a4a6a },
  { id: "birdperson_peak",  name: "Birdperson's Peak",   cx: -210, cz:  180, r: 60, color: 0x556677 },
];

// Points of interest for the map
export const POIS = [
  { name: "Smith Garage",       x:    0, z:    0 },
  { name: "Cronenberg Wastes",  x:  180, z:  120 },
  { name: "Citadel of Ricks",   x: -180, z: -160 },
  { name: "Cromulon Canyon",    x:  140, z: -200 },
  { name: "Birdperson's Peak",  x: -210, z:  180 },
  { name: "Shrine of Schwifty", x:   60, z:  -50 },
  { name: "Federation Outpost", x: -100, z:   80 },
];

// NPCs — placed in the world. id, position, dialogue tree, optional quest hook.
export const NPCS = [
  {
    id: "rick",
    name: "Rick Sanchez",
    pos: [6, 0, -4],
    color: 0xc0e8ff, hairColor: 0xcccccc,
    dialogue: {
      start: {
        text: "*burp* Oh great, another one. Listen, kid — the Federation's all over C-137 and the Cromulons are demanding a SHOW. Help me out and I'll, I dunno, not delete you from this dimension.",
        options: [
          { text: "What do you need? (Accept Main Quest)", next: "main", give: "main_get_schwifty" },
          { text: "Where am I?", next: "lore" },
          { text: "Maybe later.", end: true },
        ]
      },
      main: {
        text: "Hunt down 5 Galactic Federation troopers. They patrol north of here. Bring me a *burp* show, Morty—I mean, kid.",
        options: [{ text: "On it.", end: true }]
      },
      lore: {
        text: "You're in dimension C-137. *burp* It's like every other dimension except this one's got, y'know, you. Don't get attached.",
        options: [{ text: "...Right.", next: "start" }]
      },
      done_main: {
        text: "Five down? *burp* Decent. Take this Plasma Rifle. Now go find Morty — he's wandered off again.",
        options: [{ text: "Thanks, Rick.", end: true, reward: { item: "plasmaRifle", schmeckles: 100 } }]
      }
    },
  },
  {
    id: "morty",
    name: "Morty Smith",
    pos: [12, 0, 8],
    color: 0xffe680, hairColor: 0x7a4a2a,
    dialogue: {
      start: {
        text: "Aw geez, you scared me! Rick sent me out here and there's CRONENBERGS everywhere, man! C-can you clear them out for me? I'll give you my szechuan sauce stash.",
        options: [
          { text: "Sure, Morty. (Accept Cronenberg Cleanup)", next: "ack", give: "morty_cronenbergs" },
          { text: "I gotta go.", end: true }
        ]
      },
      ack: { text: "T-thanks! There's like 6 of them, I think. Maybe more. Aw man.", options: [{ text: "Bye.", end: true }] },
      done_morty: {
        text: "Y-you did it! Here, take this. Don't tell Rick.",
        options: [{ text: "Cool.", end: true, reward: { item: "szechuanSauce", schmeckles: 60 } }]
      }
    }
  },
  {
    id: "jerry",
    name: "Jerry Smith",
    pos: [-8, 0, 6],
    color: 0xffaa88, hairColor: 0x553322,
    dialogue: {
      start: {
        text: "Oh, hi! Listen — I, uh, dropped my Plumbus somewhere out in the wastes. Could you... y'know... find it? I'd really appreciate it.",
        options: [
          { text: "Fine. (Accept Jerry's Errand)", next: "ack", give: "jerry_plumbus" },
          { text: "Hard pass.", end: true }
        ]
      },
      ack: { text: "Great! It's east of here. Probably. Possibly. Try not to lose this one too.", options: [{ text: "Mm.", end: true }] },
      done_jerry: {
        text: "Wow, you actually did it?! Take these schmeckles, I won them in a lottery!",
        options: [{ text: "Sure, Jerry.", end: true, reward: { item: "schwiftyPotion", schmeckles: 30 } }]
      }
    }
  },
  {
    id: "birdperson",
    name: "Birdperson",
    pos: [-208, 0, 178],
    color: 0x5a4633, hairColor: 0x222222,
    dialogue: {
      start: {
        text: "In bird culture, this is considered a greeting. The Cromulon stirs in the canyon to the south. Slay it, and the Federation's grip will weaken.",
        options: [
          { text: "I will. (Accept Slay the Cromulon)", next: "ack", give: "boss_cromulon" },
          { text: "What is bird culture?", next: "culture" },
          { text: "Goodbye.", end: true }
        ]
      },
      culture: {
        text: "It is many things. I have spoken.",
        options: [{ text: "...", next: "start" }]
      },
      ack: {
        text: "Take this helm. It once belonged to my father. It will not protect you, but it is heavy and that is something.",
        options: [{ text: "Thank you.", end: true, reward: { item: "birdpersonHelm" } }]
      },
      done_boss: {
        text: "You have shown them what you've got. The Cromulons will not return. In bird culture, this is the highest honor.",
        options: [{ text: "I have spoken.", end: true, reward: { item: "pickleArmor", schmeckles: 500 } }]
      }
    }
  },
];

// Quests
export const QUESTS = {
  main_get_schwifty: {
    title: "Show Me What Ya Got",
    text: "Defeat 5 Galactic Federation troopers, then return to Rick.",
    objectives: [{ type: "kill", target: "trooper", count: 5 }],
    next: { npc: "rick", node: "done_main" },
  },
  morty_cronenbergs: {
    title: "Aw Geez, Cronenbergs",
    text: "Clear 6 Cronenbergs from the Wastes for Morty.",
    objectives: [{ type: "kill", target: "cronenberg", count: 6 }],
    next: { npc: "morty", node: "done_morty" },
  },
  jerry_plumbus: {
    title: "Jerry's Plumbus",
    text: "Find Jerry's lost Plumbus somewhere east in the Wastes.",
    objectives: [{ type: "pickup", target: "lost_plumbus", count: 1 }],
    next: { npc: "jerry", node: "done_jerry" },
  },
  boss_cromulon: {
    title: "Show Them What You've Got",
    text: "Defeat the Cromulon haunting Cromulon Canyon.",
    objectives: [{ type: "kill", target: "cromulon", count: 1 }],
    next: { npc: "birdperson", node: "done_boss" },
  },
};

// Procedural pickups in the world (besides quest items)
export const WORLD_LOOT = [
  // (Lost plumbus is dropped procedurally inside cronenberg wastes)
];

// Random toast messages
export const FLAVOR = [
  "Wubba lubba dub dub!",
  "And that's the waaaay the news goes!",
  "Riggity riggity wrecked, son!",
  "Existence is pain!",
  "I'm Mr. Meeseeks, look at me!",
  "Get Schwifty!",
  "In bird culture, this is considered a dick move.",
];

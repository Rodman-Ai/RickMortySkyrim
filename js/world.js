// World generation: heightmap terrain, props, sky, day/night.
import * as THREE from "three";
import { ZONES } from "./data.js";

export const WORLD_SIZE = 600;          // total world span
export const TERRAIN_SEG = 128;         // grid resolution
const TERRAIN_AMPLITUDE = 14;

// Deterministic pseudo-random
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D value noise smoothed
function makeNoise(seed) {
  const rand = mulberry32(seed);
  const SIZE = 256;
  const grid = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  function smooth(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const aa = grid[((xi & 255) + (yi & 255) * SIZE)];
    const ba = grid[(((xi + 1) & 255) + (yi & 255) * SIZE)];
    const ab = grid[((xi & 255) + ((yi + 1) & 255) * SIZE)];
    const bb = grid[(((xi + 1) & 255) + ((yi + 1) & 255) * SIZE)];
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    return (aa * (1 - u) + ba * u) * (1 - v) + (ab * (1 - u) + bb * u) * v;
  }
  return function fbm(x, y) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < 4; o++) {
      sum += smooth(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
}

const noise = makeNoise(13371337);

export function heightAt(x, z) {
  // Smooth rolling hills with zone bias.
  const n = noise(x * 0.012, z * 0.012);   // 0..1
  let h = (n - 0.5) * 2 * TERRAIN_AMPLITUDE;
  // Cromulon canyon: deep
  const cd = Math.hypot(x - 140, z + 200);
  if (cd < 60) h -= (1 - cd / 60) * 14;
  // Birdperson peak: high
  const bd = Math.hypot(x + 210, z - 180);
  if (bd < 50) h += (1 - bd / 50) * 30;
  return h;
}

export function zoneAt(x, z) {
  let nearest = ZONES[0], nd = Infinity;
  for (const z0 of ZONES) {
    const d = Math.hypot(x - z0.cx, z - z0.cz);
    if (d < nd) { nd = d; nearest = z0; }
  }
  return nearest;
}

export class World {
  constructor(scene, quality = "med") {
    this.scene = scene;
    this.quality = quality;
    this.props = [];     // { mesh, type, hitR, x, z }
    this.shrines = [];   // respawn points
    this.lostPlumbus = null;
    this._buildSky();
    this._buildLights();
    this._buildTerrain();
    this._scatterProps();
    this._placeShrines();
    this._placeLostPlumbus();
  }

  _buildSky() {
    const geo = new THREE.SphereGeometry(800, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x4a78c8) },
        bottomColor: { value: new THREE.Color(0xffd9b8) },
        offset: { value: 33 },
        exponent: { value: 0.6 },
      },
      vertexShader: `varying vec3 vWorldPosition; void main(){ vec4 p = modelMatrix * vec4(position,1.0); vWorldPosition = p.xyz; gl_Position = projectionMatrix * viewMatrix * p; }`,
      fragmentShader: `uniform vec3 topColor; uniform vec3 bottomColor; uniform float offset; uniform float exponent; varying vec3 vWorldPosition; void main(){ float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y; gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h,0.0), exponent), 0.0)), 1.0); }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.sky);
    this.skyMat = mat;

    // Stars — points cloud on a smaller dome, only visible at night
    const starCount = 800;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      // Distribute on upper hemisphere
      const u = Math.random(), v = Math.random() * 0.5; // upper half
      const theta = u * Math.PI * 2;
      const phi = Math.acos(1 - 2 * v);
      const r = 700;
      starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi);
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0 });
    this.stars = new THREE.Points(starGeo, starMat);
    this.scene.add(this.stars);

    // Sun and moon discs (billboards)
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff4c2, transparent: true, opacity: 0.95 });
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(18, 24), sunMat);
    this.scene.add(this.sunDisc);
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xe8eaf6, transparent: true, opacity: 0.85 });
    this.moonDisc = new THREE.Mesh(new THREE.CircleGeometry(11, 20), moonMat);
    this.scene.add(this.moonDisc);
  }

  _buildLights() {
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffeecc, 0.9);
    this.sun.position.set(80, 120, 60);
    this.scene.add(this.sun);
    // Hemisphere for nicer terrain colors
    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x665544, 0.45);
    this.scene.add(this.hemi);
    // Fog
    this.scene.fog = new THREE.Fog(0xc7d3ec, 80, 380);
  }

  _buildTerrain() {
    const seg = this.quality === "low" ? 96 : this.quality === "high" ? 192 : TERRAIN_SEG;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = heightAt(x, z);
      pos.setY(i, h);
      // Color from zone biome
      const zone = zoneAt(x, z);
      tmp.setHex(zone.color);
      // height tint
      const hf = (h + TERRAIN_AMPLITUDE) / (TERRAIN_AMPLITUDE * 2);
      tmp.offsetHSL(0, 0, (hf - 0.5) * 0.1);
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = false;
    this.scene.add(this.terrain);
  }

  _addTree(x, z) {
    const y = heightAt(x, z);
    const trunkH = 4 + Math.random() * 3;
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.5, trunkH, 6);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.set(x, y + trunkH / 2, z);
    const leafGeo = new THREE.IcosahedronGeometry(2 + Math.random() * 1.5, 0);
    const palettes = [0x97ce4c, 0x5dffd1, 0xc28bff, 0xffaa66, 0x44ddaa];
    const c = palettes[(Math.random() * palettes.length) | 0];
    const leafMat = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    const leaves = new THREE.Mesh(leafGeo, leafMat);
    leaves.position.set(x, y + trunkH + 1.2, z);
    const g = new THREE.Group();
    g.add(trunk); g.add(leaves);
    this.scene.add(g);
    this.props.push({
      mesh: g, type: "tree", hitR: 0.7, x, z,
      _leaves: leaves, _swayPhase: Math.random() * Math.PI * 2,
      _baseY: leaves.position.y,
    });
  }

  _addRock(x, z) {
    const y = heightAt(x, z);
    const r = 0.8 + Math.random() * 1.6;
    const geo = new THREE.DodecahedronGeometry(r, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0x666677, flatShading: true });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + r * 0.6, z);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.scene.add(m);
    this.props.push({ mesh: m, type: "rock", hitR: r, x, z });
  }

  _addPortal(x, z) {
    const y = heightAt(x, z);
    const ringGeo = new THREE.TorusGeometry(2.4, 0.35, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x5dffd1 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(x, y + 2.4, z);
    ring.rotation.x = Math.PI / 2;
    const innerGeo = new THREE.CircleGeometry(2.0, 32);
    const innerMat = new THREE.MeshBasicMaterial({ color: 0x97ce4c, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    const inner = new THREE.Mesh(innerGeo, innerMat);
    inner.position.copy(ring.position);
    inner.rotation.x = Math.PI / 2;
    const g = new THREE.Group(); g.add(ring); g.add(inner);
    // Real point light only on "high" quality — many lights tank mobile shaders.
    let light = null;
    if (this.quality === "high") {
      light = new THREE.PointLight(0x5dffd1, 1.6, 22, 2);
      light.position.set(x, y + 2.4, z);
      g.add(light);
    }
    this.scene.add(g);
    this.props.push({ mesh: g, type: "portal", hitR: 1.2, x, z, anim: ring, _light: light });
  }

  _addHut(x, z) {
    const y = heightAt(x, z);
    const baseGeo = new THREE.BoxGeometry(5, 3, 5);
    const baseMat = new THREE.MeshLambertMaterial({ color: 0x886644, flatShading: true });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(x, y + 1.5, z);
    const roofGeo = new THREE.ConeGeometry(4, 2.5, 4);
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x553322, flatShading: true });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(x, y + 4.2, z);
    roof.rotation.y = Math.PI / 4;
    const g = new THREE.Group(); g.add(base); g.add(roof);
    this.scene.add(g);
    this.props.push({ mesh: g, type: "hut", hitR: 3.5, x, z });
  }

  _scatterProps() {
    const rand = mulberry32(98765);
    const half = WORLD_SIZE / 2 - 10;
    const totalTrees = this.quality === "low" ? 220 : this.quality === "high" ? 600 : 380;
    for (let i = 0; i < totalTrees; i++) {
      const x = (rand() - 0.5) * 2 * half;
      const z = (rand() - 0.5) * 2 * half;
      // Skip near canyons / cromulon area for variety
      const cd = Math.hypot(x - 140, z + 200);
      if (cd < 40) continue;
      // Also keep a clear lawn around Smith Garage
      if (Math.hypot(x, z) < 22) continue;
      this._addTree(x, z);
    }
    for (let i = 0; i < 220; i++) {
      const x = (rand() - 0.5) * 2 * half;
      const z = (rand() - 0.5) * 2 * half;
      if (Math.hypot(x, z) < 18) continue;
      this._addRock(x, z);
    }
    // Smith Garage village (replaces generic hut ring)
    this._buildSmithGarage();
    // Portals at each zone center (except home)
    for (const z of ZONES) {
      if (z.id === "smith_garage") continue;
      this._addPortal(z.cx + 4, z.cz);
    }
  }

  _buildSmithGarage() {
    // Hub layout around origin. Storage for night-animations:
    this._smithWindows = [];   // {mat, base} — emissive ramps with night
    this._smithLamps = [];     // {light, lampMat}
    this._smithStringLights = []; // {mat}
    this._smithSmoke = { x: 0, y: 0, z: 0, t: 0, list: [] };

    const addProp = (mesh, x, z, hitR) => {
      this.scene.add(mesh);
      this.props.push({ mesh, type: "smith", hitR: hitR ?? 0.6, x, z });
    };

    // === House (2-story Smith family home, back-left of origin) ===
    const houseX = -10, houseZ = -8, houseY = heightAt(houseX, houseZ);
    {
      const g = new THREE.Group();
      const wallMat = new THREE.MeshLambertMaterial({ color: 0xd1c1a0, flatShading: true });
      const trimMat = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a2a2a, flatShading: true });
      const ground = new THREE.Mesh(new THREE.BoxGeometry(8, 3.2, 7), wallMat);
      ground.position.y = 1.6;
      const upper = new THREE.Mesh(new THREE.BoxGeometry(8, 2.6, 7), wallMat);
      upper.position.y = 4.5;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(6.5, 2.4, 4), roofMat);
      roof.position.y = 7.0; roof.rotation.y = Math.PI / 4;
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.1), trimMat);
      door.position.set(0, 1.1, 3.55);
      // Windows — 4 panels with emissive material so they glow at night
      const winMat = new THREE.MeshLambertMaterial({ color: 0x88a4b4, emissive: 0xffd166, emissiveIntensity: 0 });
      this._smithWindows.push({ mat: winMat });
      const winSpec = [
        [-2.4, 1.7, 3.55, 1.4, 1.0],
        [ 2.4, 1.7, 3.55, 1.4, 1.0],
        [-2.4, 4.7, 3.55, 1.4, 1.0],
        [ 2.4, 4.7, 3.55, 1.4, 1.0],
      ];
      for (const [x, y, z, w, h] of winSpec) {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), winMat);
        pane.position.set(x, y, z);
        g.add(pane);
      }
      // Chimney
      const chim = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.2, 0.8), trimMat);
      chim.position.set(2.5, 7.0, -1.5);
      // Antenna
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), trimMat);
      ant.position.set(-2.4, 8.2, 0); ant.rotation.z = 0.2;

      g.add(ground); g.add(upper); g.add(roof); g.add(door); g.add(chim); g.add(ant);
      g.position.set(houseX, houseY, houseZ);
      addProp(g, houseX, houseZ, 5);
      this._smithSmoke.x = houseX + 2.5;
      this._smithSmoke.y = houseY + 8.2;
      this._smithSmoke.z = houseZ - 1.5;
    }

    // === Garage / Lab (back-right) ===
    const gX = 8, gZ = -10, gY = heightAt(gX, gZ);
    {
      const g = new THREE.Group();
      const wallMat = new THREE.MeshLambertMaterial({ color: 0xa3a1a0 });
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 7), wallMat);
      body.position.y = 2;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.4, 7.4), roofMat);
      roof.position.y = 4.2;
      // Glowing roll-up door — emissive, looks like the lab is open
      const doorMat = new THREE.MeshLambertMaterial({ color: 0x97ce4c, emissive: 0x97ce4c, emissiveIntensity: 0.6 });
      const door = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 3), doorMat);
      door.position.set(0, 1.7, 3.51);
      // Vertical lines on the door (rolling-shutter look)
      for (let i = -1.8; i <= 1.8; i += 0.6) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 2.9), new THREE.MeshBasicMaterial({ color: 0x224422 }));
        line.position.set(i, 1.7, 3.52);
        g.add(line);
      }
      // Sat dish
      const dishGeo = new THREE.SphereGeometry(0.7, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const dish = new THREE.Mesh(dishGeo, new THREE.MeshLambertMaterial({ color: 0xeeeeee }));
      dish.position.set(2.6, 4.6, -1); dish.rotation.x = Math.PI;
      // Rooftop point light bleeding out from interior
      const interior = new THREE.PointLight(0x97ce4c, 0.8, 12, 2);
      interior.position.set(0, 1.7, 1);
      g.add(body); g.add(roof); g.add(door); g.add(dish); g.add(interior);
      g.position.set(gX, gY, gZ);
      addProp(g, gX, gZ, 5);
    }

    // === Rick's UFO spaceship (parked in front yard) ===
    const sX = 0, sZ = -16, sY = heightAt(sX, sZ);
    {
      const g = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.6, 24), new THREE.MeshLambertMaterial({ color: 0x88aabb, flatShading: true }));
      disc.position.y = 1.0;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x5db8e0, transparent: true, opacity: 0.7 }));
      dome.position.y = 1.3;
      // Rim of light bulbs
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffeeaa }));
        bulb.position.set(Math.cos(a) * 2.3, 0.85, Math.sin(a) * 2.3);
        g.add(bulb);
      }
      // Three landing legs
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6), new THREE.MeshLambertMaterial({ color: 0x666666 }));
        leg.position.set(Math.cos(a) * 1.6, 0.4, Math.sin(a) * 1.6);
        g.add(leg);
      }
      g.add(disc); g.add(dome);
      g.position.set(sX, sY, sZ);
      addProp(g, sX, sZ, 2.6);
    }

    // === Wooden plank fence (ring around the property) ===
    {
      const fenceMat = new THREE.MeshLambertMaterial({ color: 0x8a6a45, flatShading: true });
      const r = 18, planks = 64;
      for (let i = 0; i < planks; i++) {
        const a = (i / planks) * Math.PI * 2;
        // Leave a gap at the front for the entrance
        if (a > 1.3 && a < 1.8) continue;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const y = heightAt(x, z);
        const plank = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.4, 0.4), fenceMat);
        plank.position.set(x, y + 0.7, z);
        plank.rotation.y = a + Math.PI / 2;
        this.scene.add(plank);
      }
      // Top rail (ring of small boxes between planks)
      for (let i = 0; i < planks; i++) {
        const a = (i / planks) * Math.PI * 2;
        if (a > 1.3 && a < 1.8) continue;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const y = heightAt(x, z);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.16), fenceMat);
        rail.position.set(x, y + 1.3, z);
        rail.rotation.y = a + Math.PI / 2;
        this.scene.add(rail);
      }
    }

    // === Streetlamps ===
    const lampPositions = [[ 16, 14], [-16, 14]];
    for (const [x, z] of lampPositions) {
      const y = heightAt(x, z);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4, 8), new THREE.MeshLambertMaterial({ color: 0x222222 }));
      pole.position.y = 2;
      const headMat = new THREE.MeshLambertMaterial({ color: 0xffe6a6, emissive: 0xffd166, emissiveIntensity: 0 });
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.6), headMat);
      head.position.y = 4.1;
      const light = new THREE.PointLight(0xffd166, 0, 14, 2);
      light.position.y = 4.0;
      g.add(pole); g.add(head); g.add(light);
      g.position.set(x, y, z);
      this.scene.add(g);
      this._smithLamps.push({ light, mat: headMat });
      this.props.push({ mesh: g, type: "lamp", hitR: 0.4, x, z });
    }

    // === String lantern lights between the two streetlamps ===
    {
      const a = lampPositions[0], b = lampPositions[1];
      const samples = 12;
      const sag = 1.6;
      for (let i = 1; i < samples; i++) {
        const t = i / samples;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        const y = heightAt(x, z) + 4.2 - Math.sin(t * Math.PI) * sag;
        const colors = [0xff5577, 0x5dffd1, 0xffd166, 0x97ce4c, 0xc28bff];
        const mat = new THREE.MeshBasicMaterial({ color: colors[i % colors.length] });
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), mat);
        bulb.position.set(x, y, z);
        this.scene.add(bulb);
        this._smithStringLights.push({ mat, baseColor: colors[i % colors.length], phase: i });
      }
    }

    // === Picnic table + benches ===
    {
      const tx = 6, tz = 6, ty = heightAt(tx, tz);
      const g = new THREE.Group();
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
      const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 1.2), woodMat);
      top.position.y = 0.85;
      const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.85, 1.0), woodMat);
      leg1.position.set(-1.0, 0.42, 0);
      const leg2 = leg1.clone(); leg2.position.x = 1.0;
      const bench1 = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.35), woodMat);
      bench1.position.set(0, 0.45, 0.85);
      const bench2 = bench1.clone(); bench2.position.z = -0.85;
      g.add(top); g.add(leg1); g.add(leg2); g.add(bench1); g.add(bench2);
      g.position.set(tx, ty, tz);
      addProp(g, tx, tz, 1.6);
    }

    // === Welcome sign at entrance ===
    {
      const sx = 0, sz = 16, sy = heightAt(sx, sz);
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const post1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 0.18), wood);
      post1.position.set(-1.4, 1.3, 0);
      const post2 = post1.clone(); post2.position.x = 1.4;
      const board = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.9, 0.12), wood);
      board.position.set(0, 2.2, 0);
      // Painted text via a canvas texture
      const tex = this._makeTextTexture("SMITH FAMILY GARAGE", "#3a2418", "#f0d9a8");
      const front = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.7), new THREE.MeshBasicMaterial({ map: tex }));
      front.position.set(0, 2.2, 0.07);
      g.add(post1); g.add(post2); g.add(board); g.add(front);
      g.position.set(sx, sy, sz);
      g.rotation.y = Math.PI;
      addProp(g, sx, sz, 1.6);
    }

    // === Mailbox ===
    {
      const mx = -1.6, mz = 14, my = heightAt(mx, mz);
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), new THREE.MeshLambertMaterial({ color: 0x5a3a22 }));
      post.position.y = 0.7;
      const box = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.6, 12, 1, true, 0, Math.PI), new THREE.MeshLambertMaterial({ color: 0x9c1f1f, side: THREE.DoubleSide, flatShading: true }));
      box.rotation.z = Math.PI / 2;
      box.position.set(0, 1.55, 0);
      const back = new THREE.Mesh(new THREE.CircleGeometry(0.22, 12, 0, Math.PI), new THREE.MeshLambertMaterial({ color: 0x9c1f1f }));
      back.rotation.y = -Math.PI / 2; back.position.set(-0.3, 1.55, 0);
      const flag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.25, 0.18), new THREE.MeshLambertMaterial({ color: 0xffd166 }));
      flag.position.set(0.3, 1.7, 0);
      g.add(post); g.add(box); g.add(back); g.add(flag);
      g.position.set(mx, my, mz);
      addProp(g, mx, mz, 0.5);
    }

    // === Cobblestone-like darker disk path under the hub (visual only) ===
    {
      const ringGeo = new THREE.RingGeometry(0, 14, 32);
      const ringMat = new THREE.MeshLambertMaterial({ color: 0x4f5040, transparent: true, opacity: 0.35 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, heightAt(0, 0) + 0.05, 0);
      this.scene.add(ring);
    }
  }

  _makeTextTexture(text, fg = "#3a2418", bg = "#f0d9a8") {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 128;
    const ctx = c.getContext("2d");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = fg; ctx.font = "bold 56px serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, c.width / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
    return tex;
  }

  _placeShrines() {
    const positions = [[0, 0], [180, 120], [-180, -160], [-210, 180]];
    for (const [x, z] of positions) {
      const y = heightAt(x, z);
      const geo = new THREE.TorusGeometry(1.4, 0.18, 8, 24);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y + 0.4, z);
      m.rotation.x = Math.PI / 2;
      this.scene.add(m);
      let light = null;
      if (this.quality === "high") {
        light = new THREE.PointLight(0xffd166, 1.2, 14, 2);
        light.position.set(x, y + 0.8, z);
        this.scene.add(light);
      }
      this.shrines.push({ x, y, z, mesh: m, light });
    }
  }

  _placeLostPlumbus() {
    // Inside cronenberg wastes-ish, eastward
    const x = 200, z = 130;
    const y = heightAt(x, z);
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.8, 4, 8), new THREE.MeshLambertMaterial({ color: 0xb86c5a }));
    body.position.y = 0.6; g.add(body);
    g.position.set(x, y, z);
    this.scene.add(g);
    this.lostPlumbus = { x, y, z, mesh: g, taken: false };
  }

  // Day/night cycle update
  update(dt, timeOfDay, cameraPos) {
    // timeOfDay: 0..1 (0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset)
    const sunAngle = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const sunY = Math.sin(sunAngle);
    const sunX = Math.cos(sunAngle);
    this.sun.position.set(sunX * 200, Math.max(10, sunY * 200), 60);
    const dayFactor = Math.max(0, sunY);
    const nightFactor = Math.max(0, -sunY);
    this.sun.intensity = 0.2 + dayFactor * 0.9;
    this.ambient.intensity = 0.18 + dayFactor * 0.45;
    this.hemi.intensity = 0.15 + dayFactor * 0.45;
    // Sky tint
    const dawnish = Math.max(0, 1 - Math.abs(sunY - 0.05) * 5);
    const top = this.skyMat.uniforms.topColor.value;
    const bot = this.skyMat.uniforms.bottomColor.value;
    top.setHSL(0.6, 0.5, 0.05 + dayFactor * 0.45);
    bot.setHSL(0.07 + dawnish * 0.05, 0.6, 0.25 + dayFactor * 0.55);
    this.scene.fog.color.copy(bot).multiplyScalar(0.8);
    this.scene.background = bot.clone().multiplyScalar(1.0);

    // Stars fade in at night
    this.stars.material.opacity = nightFactor * 0.9;
    if (cameraPos) this.stars.position.set(cameraPos.x, 0, cameraPos.z);

    // Sun & moon discs — billboards opposite each other
    const center = cameraPos || { x: 0, y: 0, z: 0 };
    const sunOrbitR = 600;
    const sx = center.x + sunX * sunOrbitR, sy = sunY * sunOrbitR, sz = center.z + 60;
    this.sunDisc.position.set(sx, sy, sz);
    this.sunDisc.lookAt(center.x, sy, center.z);
    this.sunDisc.material.opacity = Math.max(0, sunY) * 0.95;
    this.sunDisc.visible = sunY > -0.05;
    const moonAng = sunAngle + Math.PI;
    const mx = center.x + Math.cos(moonAng) * sunOrbitR, my = Math.sin(moonAng) * sunOrbitR, mz = center.z + 60;
    this.moonDisc.position.set(mx, my, mz);
    this.moonDisc.lookAt(center.x, my, center.z);
    this.moonDisc.material.opacity = nightFactor * 0.85;
    this.moonDisc.visible = nightFactor > 0.05;

    // Animate portals + tree sway + shrine pulse
    const t = performance.now() * 0.001;
    for (const p of this.props) {
      if (p.type === "portal" && p.anim) {
        p.anim.rotation.z += dt * 1.4;
        if (p._light) p._light.intensity = 1.2 + Math.sin(t * 4) * 0.4;
      } else if (p.type === "tree" && p._leaves) {
        const sway = Math.sin(t * 1.4 + p._swayPhase) * 0.06;
        p._leaves.rotation.z = sway;
        p._leaves.position.x = p.x + Math.sin(t * 1.1 + p._swayPhase) * 0.15;
      }
    }
    for (const s of this.shrines) {
      if (s.light) s.light.intensity = 1.0 + Math.sin(t * 3 + s.x) * 0.4;
    }

    // Smith Garage night-time animations
    if (this._smithWindows) {
      for (const w of this._smithWindows) {
        w.mat.emissiveIntensity = nightFactor * 0.85;
      }
    }
    if (this._smithLamps) {
      for (const l of this._smithLamps) {
        const intensity = nightFactor * (1.4 + Math.sin(t * 6 + l.light.position.x) * 0.15);
        l.light.intensity = intensity;
        l.mat.emissiveIntensity = nightFactor * 0.9;
      }
    }
    if (this._smithStringLights) {
      for (const sl of this._smithStringLights) {
        // Subtle twinkle: vary HSL lightness over time
        const k = 0.6 + 0.4 * Math.sin(t * 2 + sl.phase);
        sl.mat.color.setHex(sl.baseColor);
        sl.mat.color.multiplyScalar(0.5 + k * 0.5);
      }
    }
    // Chimney smoke: spawn periodically, drift up + fade
    if (this._smithSmoke) {
      const sm = this._smithSmoke;
      sm.t -= dt;
      if (sm.t <= 0) {
        sm.t = 0.32 + Math.random() * 0.18;
        const mat = new THREE.MeshBasicMaterial({ color: 0xbfb6ae, transparent: true, opacity: 0.55 });
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.35 + Math.random() * 0.15, 6, 5), mat);
        m.position.set(sm.x + (Math.random() - 0.5) * 0.2, sm.y, sm.z + (Math.random() - 0.5) * 0.2);
        this.scene.add(m);
        sm.list.push({ mesh: m, mat, vy: 0.5 + Math.random() * 0.4, drift: (Math.random() - 0.5) * 0.3, life: 0, ttl: 4 });
      }
      for (let i = sm.list.length - 1; i >= 0; i--) {
        const p = sm.list[i];
        p.life += dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.x += p.drift * dt;
        const k = 1 - p.life / p.ttl;
        p.mat.opacity = Math.max(0, k * 0.55);
        p.mesh.scale.setScalar(1 + (1 - k) * 1.4);
        if (p.life >= p.ttl) {
          this.scene.remove(p.mesh);
          sm.list.splice(i, 1);
        }
      }
    }
  }
}
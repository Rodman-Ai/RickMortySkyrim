// World generation: heightmap terrain, props, sky, day/night.
import * as THREE from "three";
import { ZONES, WEATHERS } from "./data.js";

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

// Smith Garage hub: completely flat in a 22-unit radius and smoothly blended out to 30.
// This guarantees the doorway and floor align, and props placed via heightAt sit on a level plane.
const SMITH_FLAT_R = 22;
const SMITH_FLAT_BLEND = 30;
const SMITH_FLAT_Y = 0;

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
  // Smith Garage flat zone (with smooth blend so terrain isn't a cliff at the boundary)
  const sg = Math.hypot(x, z);
  if (sg <= SMITH_FLAT_R) return SMITH_FLAT_Y;
  if (sg < SMITH_FLAT_BLEND) {
    const t = (sg - SMITH_FLAT_R) / (SMITH_FLAT_BLEND - SMITH_FLAT_R);
    // smoothstep
    const k = t * t * (3 - 2 * t);
    return SMITH_FLAT_Y * (1 - k) + h * k;
  }
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
    this._placeWordWalls();

    // Weather state machine (#28)
    this.weatherIndex = 0;
    this.weatherTimer = 60 + Math.random() * 60;       // first transition in 1-2 min
    this.weatherParticles = [];                        // active rain/snow particle pool
    this._weatherJustChanged = true;                   // flag for main.js to read
  }

  weatherDef() { return WEATHERS[this.weatherIndex]; }

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
    this._smithWindows = [];
    this._smithLamps = [];
    this._smithStringLights = [];
    this._smithSmoke = { x: 0, y: 0, z: 0, t: 0, list: [] };
    this._smithDoor = null;       // {group, hinge, openTarget, current, x, z}
    this._smithTV = null;          // {mat, baseColor}
    this._ambient = [];            // walking/sitting characters
    this._containers = [];         // {x, z, mesh, lid, loot, opened}

    const addProp = (mesh, x, z, hitR) => {
      this.scene.add(mesh);
      this.props.push({ mesh, type: "smith", hitR: hitR ?? 0.6, x, z });
    };
    // AABB wall: thin box collider aligned to world axes
    const addWall = (cx, cz, sx, sz, mesh) => {
      this.scene.add(mesh);
      this.props.push({
        mesh, type: "wall", x: cx, z: cz, hitR: 0,
        hitAABB: { minX: cx - sx / 2, maxX: cx + sx / 2, minZ: cz - sz / 2, maxZ: cz + sz / 2 },
      });
    };

    // === House (hollow, enterable, with interior dressing) ===
    // Footprint: 8 wide (X) x 7 deep (Z), centered at (-10, -8). Front door on +Z face.
    const houseX = -10, houseZ = -8, houseY = heightAt(houseX, houseZ);
    const HW = 8, HD = 7, GH = 3.2, T = 0.2;   // GH = ground-floor inner height
    const houseFloorY = houseY;
    const houseCeilingY = houseY + GH;
    {
      const wallMat = new THREE.MeshLambertMaterial({ color: 0xd1c1a0, flatShading: true });
      const innerMat = new THREE.MeshLambertMaterial({ color: 0xe8d5b0 });
      const trimMat = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a2a2a, flatShading: true });
      const floorMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });

      // Floor
      const floor = new THREE.Mesh(new THREE.BoxGeometry(HW, 0.1, HD), floorMat);
      floor.position.set(houseX, houseFloorY + 0.05, houseZ);
      this.scene.add(floor);

      // Ceiling (interior)
      const ceil = new THREE.Mesh(new THREE.BoxGeometry(HW, 0.1, HD), innerMat);
      ceil.position.set(houseX, houseCeilingY, houseZ);
      this.scene.add(ceil);

      // Outer walls — split front wall around door cutout (1.6 wide centered)
      // North (back) wall:
      let m = new THREE.Mesh(new THREE.BoxGeometry(HW, GH, T), wallMat);
      m.position.set(houseX, houseFloorY + GH / 2, houseZ - HD / 2);
      addWall(houseX, houseZ - HD / 2, HW, T, m);
      // West wall:
      m = new THREE.Mesh(new THREE.BoxGeometry(T, GH, HD), wallMat);
      m.position.set(houseX - HW / 2, houseFloorY + GH / 2, houseZ);
      addWall(houseX - HW / 2, houseZ, T, HD, m);
      // East wall:
      m = new THREE.Mesh(new THREE.BoxGeometry(T, GH, HD), wallMat);
      m.position.set(houseX + HW / 2, houseFloorY + GH / 2, houseZ);
      addWall(houseX + HW / 2, houseZ, T, HD, m);
      // South wall — split into left + right of doorway (door 1.6 wide)
      const doorW = 1.6, doorH = 2.4;
      const sideW = (HW - doorW) / 2;
      m = new THREE.Mesh(new THREE.BoxGeometry(sideW, GH, T), wallMat);
      m.position.set(houseX - (doorW / 2 + sideW / 2), houseFloorY + GH / 2, houseZ + HD / 2);
      addWall(houseX - (doorW / 2 + sideW / 2), houseZ + HD / 2, sideW, T, m);
      m = new THREE.Mesh(new THREE.BoxGeometry(sideW, GH, T), wallMat);
      m.position.set(houseX + (doorW / 2 + sideW / 2), houseFloorY + GH / 2, houseZ + HD / 2);
      addWall(houseX + (doorW / 2 + sideW / 2), houseZ + HD / 2, sideW, T, m);
      // Lintel above door
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW, GH - doorH, T), wallMat);
      lintel.position.set(houseX, houseFloorY + doorH + (GH - doorH) / 2, houseZ + HD / 2);
      this.scene.add(lintel);

      // Upper floor (decorative — not enterable) and roof
      const upper = new THREE.Mesh(new THREE.BoxGeometry(HW, 2.6, HD), wallMat);
      upper.position.set(houseX, houseCeilingY + 1.4, houseZ);
      this.scene.add(upper);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(6.5, 2.4, 4), roofMat);
      roof.position.set(houseX, houseCeilingY + 3.7, houseZ); roof.rotation.y = Math.PI / 4;
      this.scene.add(roof);

      // Front door (animated swing). Modelled as a hinge group at left jamb.
      const hinge = new THREE.Group();
      hinge.position.set(houseX - doorW / 2, houseFloorY, houseZ + HD / 2 + T / 2);
      const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 0.08), trimMat);
      doorMesh.position.set(doorW / 2, doorH / 2, 0);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffd166 }));
      knob.position.set(doorW - 0.18, doorH / 2 - 0.1, 0.07);
      hinge.add(doorMesh); hinge.add(knob);
      this.scene.add(hinge);
      this._smithDoor = { hinge, current: 0, target: 0, x: houseX, z: houseZ + HD / 2 };

      // Windows (upper-floor — emissive at night)
      const winMat = new THREE.MeshLambertMaterial({ color: 0x88a4b4, emissive: 0xffd166, emissiveIntensity: 0 });
      this._smithWindows.push({ mat: winMat });
      const winSpec = [
        [-2.4, houseCeilingY + 1.5, HD / 2 + 0.05, 1.4, 1.0],
        [ 2.4, houseCeilingY + 1.5, HD / 2 + 0.05, 1.4, 1.0],
      ];
      for (const [x, y, z, w, h] of winSpec) {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), winMat);
        pane.position.set(houseX + x, y, houseZ + z);
        this.scene.add(pane);
      }
      // Chimney + antenna
      const chim = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.2, 0.8), trimMat);
      chim.position.set(houseX + 2.5, houseCeilingY + 3.7, houseZ - 1.5);
      this.scene.add(chim);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), trimMat);
      ant.position.set(houseX - 2.4, houseCeilingY + 4.9, houseZ); ant.rotation.z = 0.2;
      this.scene.add(ant);

      this._smithSmoke.x = houseX + 2.5;
      this._smithSmoke.y = houseCeilingY + 4.9;
      this._smithSmoke.z = houseZ - 1.5;

      // === Interior dressing ===
      this._buildHouseInterior(houseX, houseFloorY, houseZ, HW, HD);
    }

    // === Garage / Lab (hollow, open front) ===
    const gX = 8, gZ = -10, gY = heightAt(gX, gZ);
    const GW = 8, GD = 7, GGH = 3.6;
    {
      const wallMat = new THREE.MeshLambertMaterial({ color: 0xa3a1a0 });
      const innerMat = new THREE.MeshLambertMaterial({ color: 0x9a9a9a });
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
      const floorMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });

      // Concrete floor
      const floor = new THREE.Mesh(new THREE.BoxGeometry(GW, 0.1, GD), floorMat);
      floor.position.set(gX, gY + 0.05, gZ);
      this.scene.add(floor);

      // Roof
      const roof = new THREE.Mesh(new THREE.BoxGeometry(GW + 0.4, 0.4, GD + 0.4), roofMat);
      roof.position.set(gX, gY + GGH + 0.2, gZ);
      this.scene.add(roof);

      // Three solid walls (back / east / west). Front is open.
      let m = new THREE.Mesh(new THREE.BoxGeometry(GW, GGH, T), wallMat);
      m.position.set(gX, gY + GGH / 2, gZ - GD / 2);
      addWall(gX, gZ - GD / 2, GW, T, m);
      m = new THREE.Mesh(new THREE.BoxGeometry(T, GGH, GD), wallMat);
      m.position.set(gX - GW / 2, gY + GGH / 2, gZ);
      addWall(gX - GW / 2, gZ, T, GD, m);
      m = new THREE.Mesh(new THREE.BoxGeometry(T, GGH, GD), wallMat);
      m.position.set(gX + GW / 2, gY + GGH / 2, gZ);
      addWall(gX + GW / 2, gZ, T, GD, m);

      // Front lintel (small overhang above the open front, for visual)
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(GW, 0.3, T), wallMat);
      lintel.position.set(gX, gY + GGH - 0.15, gZ + GD / 2);
      this.scene.add(lintel);

      // Sat dish on roof
      const dishGeo = new THREE.SphereGeometry(0.7, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const dish = new THREE.Mesh(dishGeo, new THREE.MeshLambertMaterial({ color: 0xeeeeee }));
      dish.position.set(gX + 2.6, gY + GGH + 1.0, gZ - 1); dish.rotation.x = Math.PI;
      this.scene.add(dish);

      // Bright green interior point light (visible through open front, lights interior props)
      const interior = new THREE.PointLight(0x97ce4c, 1.4, 16, 2);
      interior.position.set(gX, gY + GGH - 0.4, gZ);
      this.scene.add(interior);

      // === Interior dressing ===
      this._buildGarageInterior(gX, gY, gZ, GW, GD);
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

    // === Front porch + steps in front of house door ===
    {
      const houseFrontZ = houseZ + HD / 2;
      const porchY = houseY;
      const wood = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      // Porch deck (wider than door, slightly above ground)
      const deck = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.18, 1.4), wood);
      deck.position.set(houseX, porchY + 0.09, houseFrontZ + 0.7 + 0.7);
      this.scene.add(deck);
      // Two railing posts
      for (const sx of [-2.0, 2.0]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.1, 0.14), wood);
        post.position.set(houseX + sx, porchY + 0.55 + 0.18, houseFrontZ + 1.4);
        this.scene.add(post);
      }
      // Top rail
      const rail = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.08, 0.08), wood);
      rail.position.set(houseX, porchY + 1.18, houseFrontZ + 1.4);
      this.scene.add(rail);
      // Steps (3, descending away from the deck toward the lawn)
      // Deck top is at porchY + 0.18; ground at porchY. Steps fill the gap.
      const deckFrontZ = houseFrontZ + 1.4;   // front edge z of the deck
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 0.34), wood);
        s.position.set(
          houseX,
          porchY + 0.06 + (2 - i) * 0.05,
          deckFrontZ + 0.32 + i * 0.34
        );
        this.scene.add(s);
      }
      // Doormat at the deck edge (in front of door)
      const matTex = this._makeTextTexture("WELCOME TO C-137", "#1a1410", "#88693a");
      const mat = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshBasicMaterial({ map: matTex }));
      mat.rotation.x = -Math.PI / 2;
      mat.position.set(houseX, porchY + 0.19, houseFrontZ + 0.6);
      this.scene.add(mat);
      // Address plaque on house above the door
      const addrTex = this._makeTextTexture("137", "#fdd6b5", "#222222");
      const addr = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.3), new THREE.MeshBasicMaterial({ map: addrTex }));
      addr.position.set(houseX + 1.6, houseY + 2.7, houseFrontZ + 0.06);
      this.scene.add(addr);
    }

    // === Concrete driveway from gate to garage ===
    {
      const cementMat = new THREE.MeshLambertMaterial({ color: 0x8e8e8c });
      const drive = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 22), cementMat);
      drive.rotation.x = -Math.PI / 2;
      // Curve isn't easy with a plane, so we lay it as a long rectangle aimed from the gap to the garage
      const startZ = 16, endZ = -8;
      const cx = 4, cz = (startZ + endZ) / 2;
      drive.position.set(cx, heightAt(cx, cz) + 0.04, cz);
      this.scene.add(drive);
      // Cracks — thin dark lines on the slab
      for (let i = 0; i < 6; i++) {
        const crackMat = new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.7 });
        const w = 0.04, len = 0.6 + Math.random() * 1.2;
        const crack = new THREE.Mesh(new THREE.PlaneGeometry(w, len), crackMat);
        crack.rotation.x = -Math.PI / 2;
        crack.rotation.z = Math.random() * Math.PI;
        const cx2 = cx + (Math.random() - 0.5) * 3.6;
        const cz2 = cz + (Math.random() - 0.5) * 18;
        crack.position.set(cx2, heightAt(cx2, cz2) + 0.05, cz2);
        this.scene.add(crack);
      }
    }

    // === Smith family sedan in the driveway ===
    {
      const sxc = 4, szc = 4, syc = heightAt(sxc, szc);
      const g = new THREE.Group();
      const bodyMat = new THREE.MeshLambertMaterial({ color: 0x6a3a3a, flatShading: true });
      const glassMat = new THREE.MeshLambertMaterial({ color: 0x223344 });
      const tireMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
      const trimMat = new THREE.MeshLambertMaterial({ color: 0xc0c0c0 });
      // Lower body
      const lower = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 4.2), bodyMat);
      lower.position.y = 0.7;
      // Cabin (slightly narrower, recessed at front/back)
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 2.4), bodyMat);
      cabin.position.set(0, 1.2, -0.1);
      // Windshield + rear window
      const ws = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 0.06), glassMat);
      ws.position.set(0, 1.25, 1.05); ws.rotation.x = -0.35;
      const rw = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 0.06), glassMat);
      rw.position.set(0, 1.25, -1.25); rw.rotation.x = 0.4;
      // Side windows
      const sw1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 2.2), glassMat);
      sw1.position.set(0.86, 1.25, -0.1);
      const sw2 = sw1.clone(); sw2.position.x = -0.86;
      // Wheels
      for (const [wx, wz] of [[0.95, 1.4], [-0.95, 1.4], [0.95, -1.5], [-0.95, -1.5]]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 14), tireMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(wx, 0.36, wz);
        g.add(wheel);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.32, 12), trimMat);
        cap.rotation.z = Math.PI / 2;
        cap.position.set(wx, 0.36, wz);
        g.add(cap);
      }
      // Headlights + taillights
      for (const [lx, lz, color] of [[0.6, 2.05, 0xfff5b8], [-0.6, 2.05, 0xfff5b8], [0.6, -2.05, 0xff3344], [-0.6, -2.05, 0xff3344]]) {
        const light = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.06), new THREE.MeshBasicMaterial({ color }));
        light.position.set(lx, 0.85, lz);
        g.add(light);
      }
      // Side mirrors
      for (const sx of [-0.95, 0.95]) {
        const mir = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.18), bodyMat);
        mir.position.set(sx, 1.15, 0.6);
        g.add(mir);
      }
      g.add(lower); g.add(cabin); g.add(ws); g.add(rw); g.add(sw1); g.add(sw2);
      g.position.set(sxc, syc, szc);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: sxc, z: szc, hitR: 2.4 });
    }

    // === BBQ grill on the side yard ===
    {
      const bx = -16, bz = 4, by = heightAt(bx, bz);
      const g = new THREE.Group();
      const black = new THREE.MeshLambertMaterial({ color: 0x222222 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), black);
      dome.position.y = 1.0;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.4, 0.3, 14), black);
      bowl.position.y = 0.85;
      // Legs
      for (const [lx, lz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.85, 6), black);
        leg.position.set(lx, 0.42, lz);
        g.add(leg);
      }
      // Side shelf
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.4), new THREE.MeshLambertMaterial({ color: 0x666666 }));
      shelf.position.set(0.7, 0.85, 0);
      // Propane tank
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 12), new THREE.MeshLambertMaterial({ color: 0xc4a017 }));
      tank.position.set(0, 0.25, -0.6);
      g.add(dome); g.add(bowl); g.add(shelf); g.add(tank);
      g.position.set(bx, by, bz);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: bx, z: bz, hitR: 0.8 });
    }

    // === Patio table with umbrella + chairs ===
    {
      const px = -16, pz = -2, py = heightAt(px, pz);
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const fab = new THREE.MeshLambertMaterial({ color: 0x447766, flatShading: true });
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.05, 16), wood);
      top.position.y = 0.75;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.75, 8), wood);
      stem.position.y = 0.38;
      const umbrellaPole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), wood);
      umbrellaPole.position.y = 1.55;
      const umbrella = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.5, 12, 1, true), fab);
      umbrella.position.y = 2.1;
      // Chairs
      for (const [chx, chz] of [[0.0, 1.2], [0.0, -1.2]]) {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), wood);
        seat.position.set(chx, 0.45, chz);
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), wood);
        back.position.set(chx, 0.74, chz + (chz > 0 ? 0.22 : -0.22));
        const legM = new THREE.MeshLambertMaterial({ color: 0x222222 });
        for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.45, 6), legM);
          leg.position.set(chx + lx, 0.22, chz + lz);
          g.add(leg);
        }
        g.add(seat); g.add(back);
      }
      g.add(top); g.add(stem); g.add(umbrellaPole); g.add(umbrella);
      g.position.set(px, py, pz);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: px, z: pz, hitR: 1.4 });
    }

    // === Trash bins behind the house ===
    {
      const baseX = -11, baseZ = -12.6;
      const bins = [
        { offX: 0,    color: 0x2a2a2a },   // black trash
        { offX: 1.0,  color: 0x2a6a4a },   // green recycling
        { offX: 2.0,  color: 0x2a4a8a },   // blue recycling
      ];
      for (const b of bins) {
        const bx = baseX + b.offX, bz = baseZ;
        const by = heightAt(bx, bz);
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.4, 1.0, 12), new THREE.MeshLambertMaterial({ color: b.color }));
        body.position.y = 0.5;
        const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 12), new THREE.MeshLambertMaterial({ color: b.color }));
        lid.position.y = 1.05;
        g.add(body); g.add(lid);
        g.position.set(bx, by, bz);
        this.scene.add(g);
        this.props.push({ mesh: g, type: "smith", x: bx, z: bz, hitR: 0.45 });
      }
    }

    // === Apple tree (yard, NE area) ===
    {
      const tx = 14, tz = 4, ty = heightAt(tx, tz);
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 4.5, 8), new THREE.MeshLambertMaterial({ color: 0x4a3a2a }));
      trunk.position.set(tx, ty + 2.25, tz);
      const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshLambertMaterial({ color: 0x44a04a, flatShading: true }));
      canopy.position.set(tx, ty + 5.0, tz);
      g.add(trunk); g.add(canopy);
      const appleMat = new THREE.MeshLambertMaterial({ color: 0xc9261f });
      for (let i = 0; i < 14; i++) {
        const phi = Math.acos(2 * Math.random() - 1);
        const theta = Math.random() * Math.PI * 2;
        const r = 2.4 + Math.random() * 0.3;
        const ax = Math.sin(phi) * Math.cos(theta) * r;
        const ay = Math.cos(phi) * r * 0.6;
        const az = Math.sin(phi) * Math.sin(theta) * r;
        const apple = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), appleMat);
        apple.position.set(tx + ax, ty + 5.0 + ay, tz + az);
        g.add(apple);
      }
      this.scene.add(g);
      this.props.push({ mesh: g, type: "tree", x: tx, z: tz, hitR: 0.7,
                        _leaves: canopy, _swayPhase: Math.random() * Math.PI * 2 });
    }

    // === Lawn ornaments (flamingo + gnome) ===
    {
      // Pink flamingo near the porch
      {
        const fX = -7, fZ = -2, fY = heightAt(fX, fZ);
        const g = new THREE.Group();
        const pink = new THREE.MeshLambertMaterial({ color: 0xff8fa3 });
        const black = new THREE.MeshLambertMaterial({ color: 0x111111 });
        const yellow = new THREE.MeshLambertMaterial({ color: 0xffd166 });
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), pink);
        body.scale.set(1.2, 0.7, 0.7);
        body.position.y = 1.0;
        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.9, 8), pink);
        neck.position.set(0.18, 1.4, 0); neck.rotation.z = -0.3;
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), pink);
        head.position.set(0.42, 1.85, 0);
        const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 6), yellow);
        beak.position.set(0.55, 1.83, 0); beak.rotation.z = -Math.PI / 2;
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), black);
        eye.position.set(0.46, 1.9, 0.1);
        const leg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6), pink);
        leg1.position.set(0.05, 0.5, -0.1);
        const leg2 = leg1.clone(); leg2.position.x = -0.05; leg2.position.z = 0.1;
        g.add(body); g.add(neck); g.add(head); g.add(beak); g.add(eye); g.add(leg1); g.add(leg2);
        g.position.set(fX, fY, fZ);
        this.scene.add(g);
      }
      // Garden gnome on the other side
      {
        const gX = -13, gZ = -2, gY = heightAt(gX, gZ);
        const g = new THREE.Group();
        const skin = new THREE.MeshLambertMaterial({ color: 0xfdd6b5 });
        const beard = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
        const coat = new THREE.MeshLambertMaterial({ color: 0x3a6f3a });
        const hat = new THREE.MeshLambertMaterial({ color: 0xc91d1d });
        const body = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 12), coat);
        body.position.y = 0.35;
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), skin);
        head.position.y = 0.78;
        const beardMesh = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.35, 10), beard);
        beardMesh.position.y = 0.6; beardMesh.rotation.x = Math.PI;
        const hatMesh = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 12), hat);
        hatMesh.position.y = 1.1;
        g.add(body); g.add(head); g.add(beardMesh); g.add(hatMesh);
        g.position.set(gX, gY, gZ);
        this.scene.add(g);
      }
    }

    // === Bicycle leaning against the east wall of the house ===
    {
      const bx = -10 + 4 + 0.3, bz = -8 + 1.5, by = 0;
      const g = new THREE.Group();
      const frameMat = new THREE.MeshLambertMaterial({ color: 0xc91d1d });
      const tireMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
      const seatMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
      // Two wheels
      for (const tx of [-0.5, 0.5]) {
        const tire = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.06, 8, 22), tireMat);
        tire.rotation.y = Math.PI / 2;
        tire.position.set(tx, 0.32, 0);
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 14), new THREE.MeshLambertMaterial({ color: 0x888888 }));
        rim.rotation.z = Math.PI / 2;
        rim.position.set(tx, 0.32, 0);
        g.add(tire); g.add(rim);
      }
      // Frame triangle
      const t1 = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6), frameMat);
      t1.rotation.z = -0.6; t1.position.set(0, 0.55, 0);
      const t2 = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 6), frameMat);
      t2.rotation.z = 0.6; t2.position.set(0.2, 0.6, 0);
      const t3 = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 6), frameMat);
      t3.position.set(-0.18, 0.5, 0);
      // Seat post + seat
      const seatPost = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), frameMat);
      seatPost.position.set(-0.18, 0.85, 0);
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.1), seatMat);
      seat.position.set(-0.18, 1.05, 0);
      // Handlebars
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), frameMat);
      stem.position.set(0.5, 0.85, 0);
      const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.45, 6), seatMat);
      bars.rotation.x = Math.PI / 2;
      bars.position.set(0.5, 1.0, 0);
      g.add(t1); g.add(t2); g.add(t3); g.add(seatPost); g.add(seat); g.add(stem); g.add(bars);
      g.rotation.y = Math.PI / 2;          // align bike with the wall
      g.rotation.z = -0.18;                 // lean against the house
      g.position.set(bx, by, bz);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: bx, z: bz, hitR: 0.6 });
    }

    // === Coiled garden hose against west wall of house ===
    {
      const hx = -10 - 4 - 0.5, hz = -8 + 1.0, hy = 0;
      const g = new THREE.Group();
      const hoseMat = new THREE.MeshLambertMaterial({ color: 0x2a6a4a });
      // Build a stack of horizontal torus rings to fake a coiled hose
      for (let i = 0; i < 4; i++) {
        const r = 0.45 - i * 0.04;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.05, 8, 28), hoseMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.06 + i * 0.1;
        g.add(ring);
      }
      // Spigot on the wall
      const spigot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8), new THREE.MeshLambertMaterial({ color: 0x999999 }));
      spigot.rotation.x = Math.PI / 2;
      spigot.position.set(0.0, 0.55, -0.3);
      // Loose end snaking down to the coil
      const looseEnd = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 6), hoseMat);
      looseEnd.position.set(0, 0.4, -0.18);
      looseEnd.rotation.x = -0.7;
      g.add(spigot); g.add(looseEnd);
      g.position.set(hx, hy, hz);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: hx, z: hz, hitR: 0.5 });
    }

    // === Yard sign on a stake ===
    {
      const sx = 8, sz = 12, sy = 0;
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 0.06), wood);
      post.position.y = 0.7;
      const tex = this._makeTextTexture("TRESPASSERS WILL\nBE CRONENBERGED", "#1a1410", "#d4c094");
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.6), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      board.position.y = 1.2;
      g.add(post); g.add(board);
      g.rotation.y = -0.3;
      g.position.set(sx, sy, sz);
      this.scene.add(g);
    }

    // === Solar panels on garage roof ===
    {
      const grX = 8, grZ = -10;
      const ROOF_Y = 3.6 + 0.4 + 0.05;
      const panelMat = new THREE.MeshLambertMaterial({ color: 0x10283d });
      const frameMat = new THREE.MeshLambertMaterial({ color: 0xbbbbbb });
      // 2x3 array of panels
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 3; j++) {
          const px = grX - 2.4 + j * 2.0;
          const pz = grZ - 1.6 + i * 1.6;
          const panel = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 1.4), panelMat);
          panel.position.set(px, ROOF_Y + 0.18, pz);
          panel.rotation.x = -0.18;
          // Glossy grid lines on the panel surface
          const grid = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.3), new THREE.MeshBasicMaterial({ color: 0x1f4a78, transparent: true, opacity: 0.6 }));
          grid.position.set(px, ROOF_Y + 0.215, pz);
          grid.rotation.x = -Math.PI / 2 - 0.18;
          // Frame underneath as a small support
          const support = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.04), frameMat);
          support.position.set(px - 0.8, ROOF_Y + 0.1, pz - 0.6);
          this.scene.add(panel); this.scene.add(grid); this.scene.add(support);
        }
      }
    }

    // === Floating drone patrolling the yard (animated) ===
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 18, 14), new THREE.MeshLambertMaterial({ color: 0x444455 }));
      body.position.y = 0;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), new THREE.MeshBasicMaterial({ color: 0x97ce4c }));
      eye.position.set(0, 0, 0.18);
      // Four rotor arms with discs
      const armMat = new THREE.MeshLambertMaterial({ color: 0x222233 });
      const rotorMat = new THREE.MeshLambertMaterial({ color: 0x666666, transparent: true, opacity: 0.4 });
      const rotors = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.32, 6), armMat);
        arm.position.set(Math.cos(a) * 0.16, 0.04, Math.sin(a) * 0.16);
        arm.rotation.z = Math.PI / 2;
        arm.rotation.y = -a;
        const rotor = new THREE.Mesh(new THREE.CircleGeometry(0.16, 18), rotorMat);
        rotor.rotation.x = -Math.PI / 2;
        rotor.position.set(Math.cos(a) * 0.32, 0.1, Math.sin(a) * 0.32);
        rotors.add(arm); rotors.add(rotor);
      }
      const light = new THREE.PointLight(0x97ce4c, 0.8, 6, 2);
      light.position.y = 0.2;
      g.add(body); g.add(eye); g.add(rotors); g.add(light);
      this.scene.add(g);
      this._smithDrone = {
        mesh: g, rotors, light, eye,
        path: [{ x: -8, z: 12 }, { x: 8, z: 12 }, { x: 12, z: 0 }, { x: 0, z: -2 }, { x: -12, z: 0 }],
        target: 1, speed: 3.0, t: 0,
      };
      // Initial position
      const p0 = this._smithDrone.path[0];
      g.position.set(p0.x, 3.2, p0.z);
    }

    // === Telescope on the porch (Rick's stargazing rig) ===
    {
      const tx = -10 + 1.6, tz = -8 + 4.5, ty = 0.3;
      const g = new THREE.Group();
      const dark = new THREE.MeshLambertMaterial({ color: 0x222233 });
      const brass = new THREE.MeshLambertMaterial({ color: 0xc0a04a });
      // Tripod legs
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 8), dark);
        leg.position.set(Math.cos(a) * 0.18, 0.5, Math.sin(a) * 0.18);
        leg.rotation.z = -Math.cos(a) * 0.25;
        leg.rotation.x = Math.sin(a) * 0.25;
        g.add(leg);
      }
      // Mount + tube
      const mount = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.1), dark);
      mount.position.y = 1.05;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 18, 4), dark);
      tube.rotation.z = -0.7; tube.position.set(0.05, 1.25, 0);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.02, 8, 22), brass);
      rim.position.set(0.27, 1.45, 0); rim.rotation.y = -0.7 + Math.PI / 2;
      const eyepiece = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.16, 12), dark);
      eyepiece.rotation.z = -0.7 + Math.PI / 2;
      eyepiece.position.set(-0.22, 1.05, 0);
      g.add(mount); g.add(tube); g.add(rim); g.add(eyepiece);
      g.position.set(tx, ty, tz);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: tx, z: tz, hitR: 0.45 });
    }

    // === Hanging flower planters off the porch railing ===
    {
      const houseFrontZ = -8 + 3.5;
      const railZ = houseFrontZ + 1.4;
      const railY = 1.18;
      for (const xx of [-12, -10, -8]) {
        const g = new THREE.Group();
        // Strap
        const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
        strap.position.y = -0.2;
        // Pot (terracotta)
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.18, 22, 2), new THREE.MeshLambertMaterial({ color: 0xb8612b }));
        pot.position.y = -0.55;
        // Flowers — cluster of small spheres on top
        const colors = [0xff5577, 0xffd166, 0x97ce4c, 0xc28bff];
        for (let i = 0; i < 6; i++) {
          const c = colors[(i + (xx | 0)) % colors.length];
          const flower = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 12), new THREE.MeshLambertMaterial({ color: c }));
          const a = (i / 6) * Math.PI * 2;
          flower.position.set(Math.cos(a) * 0.1, -0.42, Math.sin(a) * 0.1);
          g.add(flower);
        }
        g.add(strap); g.add(pot);
        g.position.set(xx, railY, railZ + 0.16);
        this.scene.add(g);
      }
    }

    // === Ladder leaning against the garage west wall ===
    {
      const lx = 8 - 4 - 0.4, lz = -10 + 0.5, ly = 0;
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0xa07a45 });
      // Two side rails
      const rL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.2, 0.06), wood);
      rL.position.set(-0.22, 1.6, 0);
      const rR = rL.clone(); rR.position.x = 0.22;
      g.add(rL); g.add(rR);
      // Rungs
      for (let i = 0; i < 9; i++) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.05), wood);
        rung.position.set(0, 0.3 + i * 0.35, 0);
        g.add(rung);
      }
      g.position.set(lx, ly, lz);
      g.rotation.x = -0.18;        // lean angle
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: lx, z: lz, hitR: 0.4 });
    }

    // === Exhaust fan on the back of the garage (animated) ===
    {
      const ex = 8 + 0.5, ey = 2.8, ez = -10 - 3.5 - 0.06;
      const g = new THREE.Group();
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.12), new THREE.MeshLambertMaterial({ color: 0x444444 }));
      housing.position.set(0, 0, 0);
      const grilleMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
      // Concentric ring grille
      for (let r = 0.12; r < 0.42; r += 0.08) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 32), grilleMat);
        ring.position.z = -0.08;
        g.add(ring);
      }
      // Spinning blades
      const blades = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.02), new THREE.MeshLambertMaterial({ color: 0x999999 }));
        blade.rotation.y = i * Math.PI / 2;
        blades.add(blade);
      }
      blades.position.z = -0.06;
      g.add(housing); g.add(blades);
      // Orient against the back (north) wall of the garage so it faces outward (+ -Z)
      g.position.set(8, 2.8, -10 - 3.5 - 0.07);
      this.scene.add(g);
      this._smithExhaust = blades;
    }

    // === Flower bed along the front of the house ===
    {
      const houseFrontZ = -8 + 3.5;
      const bedY = 0;
      // Bed border (wooden frame)
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const bedW = 7.5, bedD = 0.8;
      // Place south of the porch steps, between the porch and the front lawn
      const bedCx = -10, bedCz = houseFrontZ + 3.2;
      // Border planks
      const front = new THREE.Mesh(new THREE.BoxGeometry(bedW, 0.18, 0.12), woodMat);
      front.position.set(bedCx, bedY + 0.09, bedCz + bedD / 2);
      const back = front.clone();
      back.position.z = bedCz - bedD / 2;
      const left = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, bedD), woodMat);
      left.position.set(bedCx - bedW / 2, bedY + 0.09, bedCz);
      const right = left.clone();
      right.position.x = bedCx + bedW / 2;
      this.scene.add(front); this.scene.add(back); this.scene.add(left); this.scene.add(right);
      // Soil
      const soil = new THREE.Mesh(new THREE.BoxGeometry(bedW - 0.2, 0.05, bedD - 0.2), new THREE.MeshLambertMaterial({ color: 0x4a3325 }));
      soil.position.set(bedCx, bedY + 0.1, bedCz);
      this.scene.add(soil);
      // Flowers — clusters of color spheres + green stems
      const flowerColors = [0xff5577, 0xffd166, 0x97ce4c, 0xc28bff, 0x5dffd1, 0xffaa66];
      for (let i = 0; i < 22; i++) {
        const fx = bedCx + (Math.random() - 0.5) * (bedW - 0.4);
        const fz = bedCz + (Math.random() - 0.5) * (bedD - 0.3);
        const stemH = 0.18 + Math.random() * 0.15;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, stemH, 6), new THREE.MeshLambertMaterial({ color: 0x2a6a3a }));
        stem.position.set(fx, bedY + 0.13 + stemH / 2, fz);
        this.scene.add(stem);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 12), new THREE.MeshLambertMaterial({ color: flowerColors[i % flowerColors.length] }));
        head.position.set(fx, bedY + 0.13 + stemH + 0.05, fz);
        this.scene.add(head);
      }
    }

    // === Hammock between two yard trees (decorative) ===
    {
      // Pick two posts in the lawn — drive small wooden posts and hammock between them
      const ax = -6, az = 9, bx = -2, bz = 9;
      const ay = 0, by = 0;
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const fab = new THREE.MeshLambertMaterial({ color: 0xff8866, side: THREE.DoubleSide });
      // Posts
      const postA = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 14, 3), woodMat);
      postA.position.set(ax, 0.75, az);
      const postB = postA.clone();
      postB.position.set(bx, 0.75, bz);
      this.scene.add(postA); this.scene.add(postB);
      // Hammock — sagging plane between posts
      const dx = bx - ax, dz = bz - az;
      const dist = Math.hypot(dx, dz);
      const segs = 12;
      const hamGeo = new THREE.PlaneGeometry(dist, 0.7, segs, 1);
      const pos = hamGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const u = (pos.getX(i) + dist / 2) / dist;
        const sag = -Math.sin(u * Math.PI) * 0.35;
        pos.setY(i, pos.getY(i) + sag);
      }
      hamGeo.computeVertexNormals();
      const ham = new THREE.Mesh(hamGeo, fab);
      ham.position.set((ax + bx) / 2, 1.05, (az + bz) / 2);
      ham.rotation.y = Math.atan2(dz, dx);
      this.scene.add(ham);
      // Anchor ropes
      const ropeMat = new THREE.MeshLambertMaterial({ color: 0xf0e0c0 });
      for (const [px, pz] of [[ax, az], [bx, bz]]) {
        const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 6), ropeMat);
        rope.position.set(px, 1.25, pz);
        this.scene.add(rope);
      }
      // Treat posts as cylinder colliders
      this.props.push({ mesh: postA, type: "smith", x: ax, z: az, hitR: 0.15 });
      this.props.push({ mesh: postB, type: "smith", x: bx, z: bz, hitR: 0.15 });
    }

    // === Ambient characters from the show ===
    this._buildAmbientCharacters();

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

  _buildHouseInterior(cx, cy, cz, w, d) {
    // Coordinates inside the house, given center (cx,cy,cz)
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x88a4b4 });
    // Rug in center
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2), new THREE.MeshLambertMaterial({ color: 0x4f3a2c }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(cx, cy + 0.06, cz);
    this.scene.add(rug);

    // Couch — back against west wall, length along Z
    {
      const g = new THREE.Group();
      const fab = new THREE.MeshLambertMaterial({ color: 0x36506e });
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 2.6), fab);
      base.position.set(0, 0.25, 0);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 2.6), fab);
      back.position.set(-0.3, 0.7, 0);
      const armL = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.25), fab);
      armL.position.set(0, 0.5, 1.3);
      const armR = armL.clone(); armR.position.z = -1.3;
      g.add(base); g.add(back); g.add(armL); g.add(armR);
      g.position.set(cx - w / 2 + 0.7, cy + 0.1, cz);
      this.scene.add(g);
      this._couchPos = { x: g.position.x, y: g.position.y, z: g.position.z };
    }

    // Coffee table on rug
    {
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.9), wood);
      top.position.y = 0.5;
      for (const [px, pz] of [[-0.7, -0.4], [0.7, -0.4], [-0.7, 0.4], [0.7, 0.4]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), wood);
        leg.position.set(px, 0.25, pz);
        g.add(leg);
      }
      g.add(top);
      g.position.set(cx + 0.4, cy + 0.06, cz);
      this.scene.add(g);
      // beer cans on the table
      for (let i = 0; i < 3; i++) {
        const can = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.22, 10), new THREE.MeshLambertMaterial({ color: i % 2 ? 0xc4a017 : 0xc91d1d }));
        can.position.set(cx + 0.4 + (i - 1) * 0.4, cy + 0.6 + 0.11, cz - 0.3 + Math.random() * 0.2);
        this.scene.add(can);
      }
      // a magazine
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.02, 0.35), new THREE.MeshLambertMaterial({ color: 0xeeeeee }));
      mag.position.set(cx + 0.4, cy + 0.6 + 0.02, cz + 0.25);
      mag.rotation.y = 0.4;
      this.scene.add(mag);
    }

    // TV on stand (against east wall, facing west)
    {
      const g = new THREE.Group();
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
      stand.position.y = 0.25;
      const tvBody = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.85, 1.5), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      tvBody.position.set(0.0, 0.95, 0);
      const screenMat = new THREE.MeshBasicMaterial({ color: 0x55c5e5 });
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 1.3), screenMat);
      screen.position.set(-0.07, 0.95, 0);
      g.add(stand); g.add(tvBody); g.add(screen);
      g.position.set(cx + w / 2 - 0.4, cy + 0.1, cz);
      this.scene.add(g);
      this._smithTV = { mat: screenMat, baseColor: 0x55c5e5 };
    }

    // Fridge in NW corner with photo magnets on the door
    {
      const fx = cx - w / 2 + 0.55, fy = cy + 0.95, fz = cz - d / 2 + 0.5;
      const fridge = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.8), new THREE.MeshLambertMaterial({ color: 0xeeeeee }));
      fridge.position.set(fx, fy, fz);
      this.scene.add(fridge);
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.7), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
      door.position.set(fx + 0.45, fy, fz);
      this.scene.add(door);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.04), new THREE.MeshLambertMaterial({ color: 0xc0c0c0 }));
      handle.position.set(fx + 0.5, fy + 0.4, fz - 0.28);
      this.scene.add(handle);
      // Photo magnets — small bright squares stuck to the door
      const magColors = [0xff5577, 0xffd166, 0x97ce4c, 0x5dffd1, 0xc28bff, 0xffaa66];
      for (let i = 0; i < 8; i++) {
        const c = magColors[i % magColors.length];
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), new THREE.MeshBasicMaterial({ color: c }));
        m.position.set(
          fx + 0.48,
          fy + 0.4 + (Math.random() - 0.5) * 1.0,
          fz + (Math.random() - 0.5) * 0.55
        );
        m.rotation.y = -Math.PI / 2;
        m.rotation.z = (Math.random() - 0.5) * 0.4;
        this.scene.add(m);
      }
    }

    // Stove next to fridge — with pots and a hanging utensil rack above
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 0.7), new THREE.MeshLambertMaterial({ color: 0x888888 }));
      body.position.y = 0.5;
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.05, 0.72), new THREE.MeshBasicMaterial({ color: 0x222222 }));
      top.position.y = 1.02;
      // 4 burners
      for (const [bx, bz] of [[-0.22, 0.18], [0.22, 0.18], [-0.22, -0.18], [0.22, -0.18]]) {
        const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.02, 14), new THREE.MeshBasicMaterial({ color: 0x4a3a2a }));
        burner.position.set(bx, 1.05, bz);
        g.add(burner);
      }
      // Pots on the stovetop
      const pot1 = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.18, 14), new THREE.MeshLambertMaterial({ color: 0x222222 }));
      pot1.position.set(-0.22, 1.16, 0.18);
      const lid1 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 14), new THREE.MeshLambertMaterial({ color: 0x4a4a4a }));
      lid1.position.set(-0.22, 1.27, 0.18);
      const handle = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
      handle.position.set(-0.22, 1.31, 0.18);
      const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 0.06, 14), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      pan.position.set(0.22, 1.08, -0.18);
      const panHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.4, 6), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      panHandle.rotation.z = Math.PI / 2; panHandle.position.set(0.5, 1.08, -0.18);
      // Knobs on the front face
      for (const kx of [-0.3, -0.1, 0.1, 0.3]) {
        const kn = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 8), new THREE.MeshLambertMaterial({ color: 0x222222 }));
        kn.rotation.x = Math.PI / 2; kn.position.set(kx, 0.85, 0.36);
        g.add(kn);
      }
      g.add(body); g.add(top); g.add(pot1); g.add(lid1); g.add(handle); g.add(pan); g.add(panHandle);
      g.position.set(cx - w / 2 + 1.55, cy + 0.05, cz - d / 2 + 0.5);
      this.scene.add(g);

      // Hanging utensil rack above the stove
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 8), new THREE.MeshLambertMaterial({ color: 0xc0c0c0 }));
      rod.rotation.z = Math.PI / 2;
      rod.position.set(cx - w / 2 + 1.55, cy + 0.05 + 1.9, cz - d / 2 + 0.18);
      this.scene.add(rod);
      const utensilColors = [0xc0c0c0, 0x222222, 0x999999];
      for (let i = 0; i < 4; i++) {
        const u = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.02), new THREE.MeshLambertMaterial({ color: utensilColors[i % utensilColors.length] }));
        u.position.set(cx - w / 2 + 1.2 + i * 0.22, cy + 0.05 + 1.7, cz - d / 2 + 0.18);
        this.scene.add(u);
      }
    }

    // Floor lamp in NE corner
    {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.7, 6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
      pole.position.y = 0.85;
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.4, 12, 1, true), new THREE.MeshLambertMaterial({ color: 0xf0d9a8, emissive: 0xffd166, emissiveIntensity: 0.7, side: THREE.DoubleSide }));
      shade.position.y = 1.85;
      const bulbLight = new THREE.PointLight(0xffd9a0, 0.8, 6, 2);
      bulbLight.position.y = 1.7;
      g.add(pole); g.add(shade); g.add(bulbLight);
      g.position.set(cx + w / 2 - 0.5, cy + 0.05, cz - d / 2 + 0.5);
      this.scene.add(g);
    }

    // Container — wooden chest at NE inside corner (deep inside so south wall blocks outside reach).
    {
      const chest = this._makeChest(cx + w / 2 - 0.7, cy + 0.05, cz - d / 2 + 0.8, ["healJuice", "schwiftyPotion", "szechuanSauce"]);
      chest.kind = "house_chest";
    }

    // Floor clutter inside house
    this._scatterClutter(cx, cy, cz, w, d, "house");

    // === Ceiling fan above the living room (animated) ===
    {
      const g = new THREE.Group();
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 6), new THREE.MeshLambertMaterial({ color: 0x666666 }));
      rod.position.y = 0.05;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 14), new THREE.MeshLambertMaterial({ color: 0x222222 }));
      hub.position.y = -0.16;
      const blade = new THREE.MeshLambertMaterial({ color: 0xc4a060 });
      const fanRotor = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.22), blade);
        b.position.set(Math.cos(i * Math.PI / 2) * 0.55, 0, Math.sin(i * Math.PI / 2) * 0.55);
        b.rotation.y = i * Math.PI / 2;
        fanRotor.add(b);
      }
      fanRotor.position.y = -0.2;
      const downlight = new THREE.PointLight(0xfff1c2, 0.5, 5, 2);
      downlight.position.y = -0.4;
      g.add(rod); g.add(hub); g.add(fanRotor); g.add(downlight);
      g.position.set(cx + 0.4, cy + 3.0, cz);
      this.scene.add(g);
      this._smithFan = { rotor: fanRotor };
    }

    // === Bookshelf along the north wall ===
    {
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x4f3a2c });
      const shell = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.0, 0.35), wood);
      shell.position.y = 1.0;
      g.add(shell);
      // 4 shelves with rows of colored books
      const colors = [0x4a6, 0xa44, 0x46a, 0xa64, 0x6a4, 0x84a, 0xc94, 0x4ac];
      for (let r = 0; r < 4; r++) {
        const yy = 0.25 + r * 0.45;
        let x = -0.6;
        let i = 0;
        while (x < 0.6) {
          const w = 0.06 + Math.random() * 0.06;
          const h = 0.32 + Math.random() * 0.08;
          const c = colors[(i + r) % colors.length];
          const book = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.22), new THREE.MeshLambertMaterial({ color: c }));
          book.position.set(x + w / 2, yy + h / 2, 0);
          g.add(book);
          x += w + 0.005;
          i++;
        }
      }
      // Place against the south wall on the east side of the doorway
      g.position.set(cx + 2.4, cy + 0.05, cz + d / 2 - 0.25);
      g.rotation.y = Math.PI;
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: g.position.x, z: g.position.z, hitR: 0.7 });
    }

    // === Curtains (interior, framing each window) ===
    {
      const fab = new THREE.MeshLambertMaterial({ color: 0x99b0c0, side: THREE.DoubleSide });
      const cT = 0.04;
      // Two upper windows are at x = ±2.4 from center, on the south face (z = +d/2)
      for (const sx of [-2.4, 2.4]) {
        for (const off of [-0.55, 0.55]) {
          const c = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 1.2), fab);
          c.position.set(cx + sx + off, cy + 2.5, cz + d / 2 - 0.06);
          this.scene.add(c);
        }
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
        rod.rotation.z = Math.PI / 2;
        rod.position.set(cx + sx, cy + 3.05, cz + d / 2 - 0.06);
        this.scene.add(rod);
      }
    }

    // === Kitchen counter + sink + faucet (against north wall, next to stove) ===
    {
      const g = new THREE.Group();
      const counterMat = new THREE.MeshLambertMaterial({ color: 0xd0c8b8 });
      const cabMat = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.85, 0.6), cabMat);
      cab.position.y = 0.425;
      const top = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.07, 0.65), counterMat);
      top.position.y = 0.86;
      // Sink cutout (recessed box)
      const sink = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.45), new THREE.MeshLambertMaterial({ color: 0x444444 }));
      sink.position.set(0.3, 0.86 + 0.04, 0);
      // Faucet
      const faucet = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8), new THREE.MeshLambertMaterial({ color: 0xc0c0c0 }));
      faucet.position.set(0.3, 0.86 + 0.25, -0.18);
      const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.25, 8), new THREE.MeshLambertMaterial({ color: 0xc0c0c0 }));
      spout.rotation.x = Math.PI / 2; spout.position.set(0.3, 0.86 + 0.45, -0.06);
      // Cabinet handles
      for (const px of [-0.5, 0.0, 0.5]) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.04), new THREE.MeshLambertMaterial({ color: 0x888888 }));
        h.position.set(px, 0.62, 0.31);
        g.add(h);
      }
      g.add(cab); g.add(top); g.add(sink); g.add(faucet); g.add(spout);
      g.position.set(cx - w / 2 + 3.0, cy + 0.05, cz - d / 2 + 0.5);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: g.position.x, z: g.position.z, hitR: 1.3 });
    }

    // === Coat rack with hanging coats inside the front door ===
    {
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x4f3a2c });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.7, 14, 4), wood);
      pole.position.y = 0.85;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 18), wood);
      base.position.y = 0.03;
      // Top crown with hooks
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), wood);
      crown.position.y = 1.7;
      // Four hooks
      const hookMat = new THREE.MeshLambertMaterial({ color: 0x8a6a45 });
      const coatColors = [0x2b4a8a, 0x9c1f1f, 0x4ec0e0, 0x2a6a4a];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const hook = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 12, Math.PI), hookMat);
        hook.position.set(Math.cos(a) * 0.1, 1.55, Math.sin(a) * 0.1);
        hook.rotation.set(0, -a, Math.PI / 2);
        g.add(hook);
        // Coat hanging from the hook
        const coat = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.7, 0.16), new THREE.MeshLambertMaterial({ color: coatColors[i] }));
        coat.position.set(Math.cos(a) * 0.18, 1.18, Math.sin(a) * 0.18);
        coat.rotation.y = -a + Math.PI / 2;
        g.add(coat);
      }
      g.add(pole); g.add(base); g.add(crown);
      // Just inside the front door, west of doorway
      g.position.set(cx - 1.6, cy + 0.05, cz + d / 2 - 0.4);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: g.position.x, z: g.position.z, hitR: 0.45 });
    }

    // === Spider web in the SE ceiling corner of the house ===
    {
      const webMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
      const web = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), webMat);
      // Diagonal in the corner
      web.position.set(cx + w / 2 - 0.45, cy + 3.0, cz + d / 2 - 0.45);
      web.lookAt(cx, cy + 2.8, cz);
      this.scene.add(web);
    }

    // === Game console + two controllers on living-room floor ===
    {
      const cnsX = cx + 0.4, cnsZ = cz - 1.2;
      const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.07, 0.32), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      console_.position.set(cnsX, cy + 0.105, cnsZ);
      this.scene.add(console_);
      // power LED
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.018, 14, 10), new THREE.MeshBasicMaterial({ color: 0x97ce4c }));
      led.position.set(cnsX + 0.15, cy + 0.145, cnsZ + 0.18);
      this.scene.add(led);
      // Two controllers
      for (let i = 0; i < 2; i++) {
        const ctlBody = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.13), new THREE.MeshLambertMaterial({ color: 0x222233 }));
        const cox = cnsX + (i ? 0.45 : -0.4) + (Math.random() - 0.5) * 0.05;
        const coz = cnsZ + 0.45 + (Math.random() - 0.5) * 0.1;
        ctlBody.position.set(cox, cy + 0.085, coz);
        ctlBody.rotation.y = (Math.random() - 0.5) * 1.0;
        // sticks
        for (const sx of [-0.06, 0.06]) {
          const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.04, 10), new THREE.MeshLambertMaterial({ color: 0x111111 }));
          stick.position.set(sx, 0.045, 0);
          ctlBody.add(stick);
        }
        // a couple of buttons
        for (const [bx, bz, color] of [[0.06, -0.02, 0xff5577], [0.08, 0.02, 0x97ce4c]]) {
          const btn = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 10), new THREE.MeshBasicMaterial({ color }));
          btn.position.set(bx, 0.04, bz);
          ctlBody.add(btn);
        }
        this.scene.add(ctlBody);
      }
      // Cable to TV (a thin curve approximated as a slim cylinder)
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.2, 6), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      cable.rotation.z = Math.PI / 2;
      cable.position.set(cnsX + 0.6, cy + 0.07, cnsZ - 0.4);
      this.scene.add(cable);
    }

    // === Smoke detector with blinking LED on the ceiling ===
    {
      const sx = cx + 1.6, sz = cz + 1.2;
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 22, 2), new THREE.MeshLambertMaterial({ color: 0xeeeeee }));
      housing.position.set(sx, cy + 3.0 - 0.03, sz);
      this.scene.add(housing);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0xff3344 });
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.02, 18, 14), ledMat);
      led.position.set(sx + 0.07, cy + 3.0 - 0.05, sz);
      this.scene.add(led);
      this._smithSmokeLED = ledMat;
    }

    // === Pizza boxes stacked on the coffee table ===
    {
      const ctableX = cx + 0.4, ctableZ = cz, ctableTop = cy + 0.06 + 0.5 + 0.04;
      for (let i = 0; i < 2; i++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.55), new THREE.MeshLambertMaterial({ color: i ? 0xc97a3a : 0xe2a55a }));
        box.position.set(ctableX - 0.4, ctableTop + i * 0.07, ctableZ + 0.1);
        box.rotation.y = i * 0.2;
        this.scene.add(box);
      }
    }
  }

  _buildGarageInterior(cx, cy, cz, w, d) {
    // Workbench against back (north) wall
    {
      const g = new THREE.Group();
      const wood = new THREE.MeshLambertMaterial({ color: 0x6b3f2a });
      const metal = new THREE.MeshLambertMaterial({ color: 0x666677 });
      const top = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.1, 0.8), metal);
      top.position.y = 0.95;
      const apron = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.2, 0.8), wood);
      apron.position.y = 0.85;
      for (const px of [-1.6, 0, 1.6]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.85, 0.7), wood);
        leg.position.set(px, 0.42, 0);
        g.add(leg);
      }
      g.add(top); g.add(apron);
      g.position.set(cx, cy + 0.05, cz - d / 2 + 0.6);
      this.scene.add(g);
      // Plumbus parts on the bench
      for (let i = 0; i < 4; i++) {
        const part = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.18, 4, 6), new THREE.MeshLambertMaterial({ color: 0xc77f6c }));
        part.position.set(cx - 1.4 + i * 0.7, cy + 0.05 + 1.05, cz - d / 2 + 0.6);
        part.rotation.z = Math.PI / 2;
        this.scene.add(part);
      }
      // Tools (wrench, hammer)
      const wrench = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.45), metal);
      wrench.position.set(cx + 1.0, cy + 0.05 + 1.04, cz - d / 2 + 0.7);
      this.scene.add(wrench);
    }

    // Half-built UFO chassis in center
    {
      const g = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.4, 18), new THREE.MeshLambertMaterial({ color: 0x556677, flatShading: true }));
      disc.position.y = 0.5;
      const sparks = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffeb6c }));
      sparks.position.set(0.4, 0.7, 0.3);
      g.add(disc); g.add(sparks);
      g.position.set(cx + 0.6, cy + 0.05, cz + 1.0);
      this.scene.add(g);
      this.props.push({ mesh: g, type: "smith", x: cx + 0.6, z: cz + 1.0, hitR: 1.4 });
    }

    // Tool rack on east wall
    {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 2.4), new THREE.MeshLambertMaterial({ color: 0x6b3f2a }));
      board.position.set(cx + w / 2 - 0.06, cy + 1.6, cz);
      this.scene.add(board);
      // hanging tools
      for (let i = 0; i < 4; i++) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.08), new THREE.MeshLambertMaterial({ color: 0x9a9aa6 }));
        t.position.set(cx + w / 2 - 0.14, cy + 1.6, cz - 0.9 + i * 0.6);
        this.scene.add(t);
      }
    }

    // Container — toolbox crate
    {
      const c1 = this._makeChest(cx - w / 2 + 0.9, cy + 0.05, cz - d / 2 + 1.6, ["plasmaRifle", "schwiftyPotion", "szechuanSauce"]);
      c1.kind = "garage_chest";
    }
    // Stacked crates (decorative, blocking)
    {
      const stackGroup = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const cr = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), new THREE.MeshLambertMaterial({ color: 0x8a6a45, flatShading: true }));
        cr.position.set(0, 0.35 + i * 0.7, 0);
        stackGroup.add(cr);
      }
      stackGroup.position.set(cx - w / 2 + 0.5, cy + 0.05, cz + d / 2 - 1.0);
      this.scene.add(stackGroup);
      this.props.push({ mesh: stackGroup, type: "smith", x: stackGroup.position.x, z: stackGroup.position.z, hitR: 0.5 });
    }
    // Oil drum
    {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1, 14), new THREE.MeshLambertMaterial({ color: 0x884422, flatShading: true }));
      drum.position.set(cx + w / 2 - 1.2, cy + 0.05 + 0.5, cz + d / 2 - 1.5);
      this.scene.add(drum);
      this.props.push({ mesh: drum, type: "smith", x: drum.position.x, z: drum.position.z, hitR: 0.5 });
    }

    // Floor clutter
    this._scatterClutter(cx, cy, cz, w, d, "garage");

    // === Rick's chemistry lab corner (NW corner of garage) with bubbling beakers ===
    {
      // Lab bench
      const bench = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.05, 0.7), new THREE.MeshLambertMaterial({ color: 0x444444 }));
      bench.position.set(cx - w / 2 + 1.1, cy + 0.05 + 0.95, cz - d / 2 + 0.4);
      this.scene.add(bench);
      const apron = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 0.7), new THREE.MeshLambertMaterial({ color: 0x6b3f2a }));
      apron.position.set(cx - w / 2 + 1.1, cy + 0.05 + 0.5, cz - d / 2 + 0.4);
      this.scene.add(apron);
      this.props.push({ mesh: bench, type: "smith", x: bench.position.x, z: bench.position.z, hitR: 1.1 });

      // Beakers (one for animation reference)
      const beakerColors = [0x97ce4c, 0xff8844, 0x5db8e0];
      this._smithBeakers = [];
      for (let i = 0; i < 3; i++) {
        const beaker = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.4, 16), new THREE.MeshLambertMaterial({ color: 0xddffff, transparent: true, opacity: 0.55 }));
        const bx = cx - w / 2 + 0.35 + i * 0.35;
        const bz = cz - d / 2 + 0.4;
        const by = cy + 0.05 + 0.95 + 0.20;
        beaker.position.set(bx, by, bz);
        const liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.28, 16), new THREE.MeshLambertMaterial({ color: beakerColors[i], emissive: beakerColors[i], emissiveIntensity: 0.4 }));
        liquid.position.set(bx, by - 0.05, bz);
        this.scene.add(beaker); this.scene.add(liquid);
        this._smithBeakers.push({ x: bx, y: by + 0.15, z: bz, color: beakerColors[i], t: Math.random() * 5 });
      }
      // Erlenmeyer flask (taller, conical)
      const flask = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 14, 1, true), new THREE.MeshLambertMaterial({ color: 0xddffff, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
      flask.position.set(cx - w / 2 + 1.6, cy + 0.05 + 0.95 + 0.20, cz - d / 2 + 0.4);
      flask.rotation.x = Math.PI;
      this.scene.add(flask);
      // Test-tube rack
      const rack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.16), new THREE.MeshLambertMaterial({ color: 0x6b3f2a }));
      rack.position.set(cx - w / 2 + 1.85, cy + 0.05 + 0.95 + 0.09, cz - d / 2 + 0.3);
      this.scene.add(rack);
      for (let i = 0; i < 4; i++) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 8), new THREE.MeshLambertMaterial({ color: [0xff5577, 0x97ce4c, 0xffd166, 0x5dffd1][i] }));
        tube.position.set(cx - w / 2 + 1.71 + i * 0.09, cy + 0.05 + 0.95 + 0.20, cz - d / 2 + 0.3);
        this.scene.add(tube);
      }
      this._smithBeakers.bubblePool = [];
    }

    // === Workshop bench vise on the workbench ===
    {
      const g = new THREE.Group();
      const cast = new THREE.MeshLambertMaterial({ color: 0x4a4a55 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.08, 18), cast);
      base.position.y = 0.04;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.12), cast);
      post.position.y = 0.16;
      // Fixed jaw
      const jawF = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.04), cast);
      jawF.position.set(0, 0.27, 0.08);
      // Sliding jaw + screw
      const jawS = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.04), cast);
      jawS.position.set(0, 0.27, -0.04);
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 12), new THREE.MeshLambertMaterial({ color: 0x999999 }));
      screw.rotation.x = Math.PI / 2;
      screw.position.set(0, 0.27, -0.18);
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 8), new THREE.MeshLambertMaterial({ color: 0xc91d1d }));
      handle.position.set(0, 0.27, -0.42);
      g.add(base); g.add(post); g.add(jawF); g.add(jawS); g.add(screw); g.add(handle);
      // Mount on the workbench top (back-right edge)
      g.position.set(cx + 1.6, cy + 0.05 + 1.0, cz - d / 2 + 0.7);
      g.rotation.y = Math.PI;
      this.scene.add(g);
    }

    // === Welder's mask hanging on the east wall ===
    {
      const g = new THREE.Group();
      const shellMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
      const lensMat = new THREE.MeshBasicMaterial({ color: 0x335533 });
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.32, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2), shellMat);
      shell.rotation.x = Math.PI / 2;
      const front = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.45, 0.05), shellMat);
      front.position.set(0, 0, 0.24);
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.06), lensMat);
      lens.position.set(0, 0.05, 0.27);
      // Headband strap
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.02), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      strap.position.set(0, 0.18, -0.05);
      // Hook nail
      const nail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.06, 6), new THREE.MeshLambertMaterial({ color: 0x555555 }));
      nail.rotation.x = Math.PI / 2;
      nail.position.set(0, 0.32, -0.06);
      g.add(shell); g.add(front); g.add(lens); g.add(strap); g.add(nail);
      g.position.set(cx + w / 2 - 0.12, cy + 1.9, cz + 1.4);
      g.rotation.y = -Math.PI / 2;
      this.scene.add(g);
    }

    // === Spider web in the NE ceiling corner of the garage ===
    {
      const webMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
      const web = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), webMat);
      web.position.set(cx + w / 2 - 0.6, cy + 3.4, cz - d / 2 + 0.6);
      web.lookAt(cx, cy + 3.2, cz);
      this.scene.add(web);
    }

    // === Stacked spare tires in the SW corner of the garage ===
    {
      const tx = cx - w / 2 + 0.7, tz = cz + d / 2 - 1.2;
      const tireMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
      const rimMat = new THREE.MeshLambertMaterial({ color: 0x666666 });
      const stack = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const tire = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.1, 14, 28), tireMat);
        tire.rotation.x = Math.PI / 2;
        tire.position.y = 0.1 + i * 0.22;
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 18), rimMat);
        rim.position.y = 0.1 + i * 0.22;
        stack.add(tire); stack.add(rim);
      }
      stack.position.set(tx, cy + 0.05, tz);
      this.scene.add(stack);
      this.props.push({ mesh: stack, type: "smith", x: tx, z: tz, hitR: 0.5 });
    }

    // === Dartboard mounted on the east wall of the garage ===
    {
      const dx = cx + w / 2 - 0.06, dy = cy + 1.9, dz = cz - 1.6;
      // Concentric rings: outer black, mid green/red alternating, bullseye
      const board = new THREE.Group();
      const layers = [
        { r: 0.45, color: 0x111111 },
        { r: 0.36, color: 0xeeeeee },
        { r: 0.30, color: 0x3a6f3a },
        { r: 0.22, color: 0xc91d1d },
        { r: 0.14, color: 0x3a6f3a },
        { r: 0.08, color: 0xc91d1d },
        { r: 0.04, color: 0x111111 },
      ];
      for (const L of layers) {
        const m = new THREE.Mesh(new THREE.CircleGeometry(L.r, 32), new THREE.MeshLambertMaterial({ color: L.color }));
        m.position.set(0, 0, board.children.length * 0.0005); // tiny offsets to avoid z-fight
        board.add(m);
      }
      // Three darts stuck near the center
      const dartFlight = new THREE.MeshLambertMaterial({ color: 0xffd166 });
      const dartBody = new THREE.MeshLambertMaterial({ color: 0xc0c0c0 });
      for (let i = 0; i < 3; i++) {
        const ang = i * 1.2;
        const r = 0.06 + i * 0.04;
        const dartGroup = new THREE.Group();
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.18, 8), dartBody);
        shaft.rotation.x = Math.PI / 2; shaft.position.z = 0.09;
        const flight = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.1, 8), dartFlight);
        flight.rotation.x = Math.PI / 2; flight.position.z = 0.22;
        dartGroup.add(shaft); dartGroup.add(flight);
        dartGroup.position.set(Math.cos(ang) * r, Math.sin(ang) * r, 0.005);
        board.add(dartGroup);
      }
      board.position.set(dx, dy, dz);
      board.rotation.y = -Math.PI / 2;
      this.scene.add(board);
    }

    // === Holographic rotating molecule in Rick's chemistry corner ===
    {
      // Floating above the lab bench; teal emitter ring + nucleus + orbiting electron spheres
      const baseX = cx - w / 2 + 1.1, baseY = cy + 0.05 + 1.0, baseZ = cz - d / 2 + 0.4;
      const emitter = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.05, 22), new THREE.MeshLambertMaterial({ color: 0x222244, emissive: 0x5dffd1, emissiveIntensity: 0.6 }));
      emitter.position.set(baseX + 1.1, baseY, baseZ + 0.25);
      this.scene.add(emitter);
      // Hologram group above emitter
      const holo = new THREE.Group();
      const nucleus = new THREE.Mesh(new THREE.SphereGeometry(0.12, 32, 24), new THREE.MeshBasicMaterial({ color: 0x97ffd1, transparent: true, opacity: 0.6 }));
      holo.add(nucleus);
      const electronMat = new THREE.MeshBasicMaterial({ color: 0x5dffd1, transparent: true, opacity: 0.7 });
      const electrons = [];
      for (let i = 0; i < 3; i++) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 22, 18), electronMat);
        holo.add(e);
        electrons.push({ mesh: e, baseAng: i * (Math.PI * 2 / 3), tiltAxis: i % 3 });
      }
      holo.position.set(baseX + 1.1, baseY + 0.55, baseZ + 0.25);
      this.scene.add(holo);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.16, 0.6, 22, 1, true), new THREE.MeshBasicMaterial({ color: 0x5dffd1, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
      beam.position.set(baseX + 1.1, baseY + 0.3, baseZ + 0.25);
      this.scene.add(beam);
      this._smithHolo = { holo, nucleus, electrons, t: 0 };
    }

    // === Hanging fluorescent tube lights ===
    {
      const tubeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.95 });
      const housingMat = new THREE.MeshLambertMaterial({ color: 0xe0e0e0 });
      for (const zOff of [-1.4, 1.4]) {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.15, 0.35), housingMat);
        housing.position.set(cx, cy + 3.4, cz + zOff);
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 10), tubeMat);
        tube.rotation.z = Math.PI / 2;
        tube.position.set(cx, cy + 3.32, cz + zOff);
        // hanging chains
        for (const chx of [-1.5, 1.5]) {
          const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 5), housingMat);
          ch.position.set(cx + chx, cy + 3.55, cz + zOff);
          this.scene.add(ch);
        }
        const ptlight = new THREE.PointLight(0xeaf2ff, 0.6, 9, 2);
        ptlight.position.set(cx, cy + 3.0, cz + zOff);
        this.scene.add(housing); this.scene.add(tube); this.scene.add(ptlight);
      }
    }

    // === Wall posters (canvas-textured planes on east + west walls) ===
    {
      const posters = [
        { text: "RICK SMITH GARAGE", fg: "#1a2418", bg: "#97ce4c", pos: [-w / 2 + 0.06, 1.9,  1.4], rot: [0, Math.PI / 2, 0] },
        { text: "WANTED: JERRY",     fg: "#ffffff", bg: "#9c1f1f", pos: [-w / 2 + 0.06, 1.9, -1.4], rot: [0, Math.PI / 2, 0] },
        { text: "C-137 CALENDAR",    fg: "#1a1a2e", bg: "#fdd6b5", pos: [ w / 2 - 0.06, 2.6,  1.6], rot: [0, -Math.PI / 2, 0] },
      ];
      for (const p of posters) {
        const tex = this._makeTextTexture(p.text, p.fg, p.bg);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshBasicMaterial({ map: tex }));
        mesh.position.set(cx + p.pos[0], cy + p.pos[1], cz + p.pos[2]);
        mesh.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
        this.scene.add(mesh);
      }
    }

    // === CRT monitor with green-screen text on the workbench ===
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), new THREE.MeshLambertMaterial({ color: 0xeae0c8 }));
      body.position.set(0, 0.225, 0);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.55), new THREE.MeshLambertMaterial({ color: 0xeae0c8 }));
      back.position.set(0, 0.225, -0.25);
      const screenTex = this._makeTextTexture("> WUBBA\n> RUN HACK_FED.SH", "#5dffd1", "#0a1a0a");
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.32), new THREE.MeshBasicMaterial({ map: screenTex }));
      screen.position.set(0, 0.25, 0.251);
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.3), new THREE.MeshLambertMaterial({ color: 0xc8c0a8 }));
      stand.position.set(0, -0.03, 0);
      const glow = new THREE.PointLight(0x5dffd1, 0.4, 2.4, 2);
      glow.position.set(0, 0.25, 0.4);
      g.add(body); g.add(back); g.add(screen); g.add(stand); g.add(glow);
      // Place on the back of the workbench top
      g.position.set(cx + 1.4, cy + 0.05 + 1.05, cz - d / 2 + 0.6);
      this.scene.add(g);
      this._smithCRT = { mat: screen.material, light: glow, baseTex: screenTex };
    }
  }

  _scatterClutter(cx, cy, cz, w, d, kind) {
    const rand = (a, b) => a + Math.random() * (b - a);
    const items = kind === "house" ? 14 : 22;
    for (let i = 0; i < items; i++) {
      const x = cx + rand(-w / 2 + 0.6, w / 2 - 0.6);
      const z = cz + rand(-d / 2 + 0.6, d / 2 - 0.6);
      const y = cy + 0.06;
      let m;
      const r = Math.random();
      if (kind === "house") {
        if (r < 0.25) {
          // beer can on floor
          m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 8), new THREE.MeshLambertMaterial({ color: 0xc4a017 }));
          m.position.set(x, y + 0.09, z); m.rotation.z = Math.PI / 2;
        } else if (r < 0.55) {
          // book
          m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.16), new THREE.MeshLambertMaterial({ color: ["#4a6", "#a44", "#46a", "#a64"][i % 4].replace("#", "0x") | 0x444444 }));
          // simpler color swap:
          m.material.color.setHex([0x447766, 0xaa4444, 0x4466aa, 0xaa6644][i % 4]);
          m.position.set(x, y + 0.02, z); m.rotation.y = Math.random() * Math.PI;
        } else if (r < 0.8) {
          // crumpled paper
          m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), new THREE.MeshLambertMaterial({ color: 0xeeeeee }));
          m.position.set(x, y + 0.08, z);
        } else {
          // toy
          m = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.1), new THREE.MeshLambertMaterial({ color: 0xffd166 }));
          m.position.set(x, y + 0.06, z);
        }
      } else {
        // garage: bolts, tools, oil rags
        if (r < 0.3) {
          m = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.04, 6), new THREE.MeshLambertMaterial({ color: 0x888888 }));
          m.position.set(x, y + 0.02, z);
        } else if (r < 0.55) {
          m = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), new THREE.MeshLambertMaterial({ color: 0x666677 }));
          m.position.set(x, y + 0.02, z); m.rotation.y = Math.random() * Math.PI;
        } else if (r < 0.8) {
          m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), new THREE.MeshLambertMaterial({ color: 0x553322 }));
          m.position.set(x, y + 0.07, z);
        } else {
          // oil stain (flat circle)
          m = new THREE.Mesh(new THREE.CircleGeometry(0.3, 12), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.65 }));
          m.rotation.x = -Math.PI / 2;
          m.position.set(x, y + 0.005, z);
        }
      }
      this.scene.add(m);
    }
  }

  _buildAmbientCharacters() {
    // Beth — sitting on the couch inside the house
    if (this._couchPos) {
      const b = this._makeHumanoid({ shirt: 0x2b6e8a, hair: 0xd6b06e, skin: 0xfdd6b5 });
      b.scale.set(0.95, 0.95, 0.95);
      b.position.set(this._couchPos.x + 0.1, this._couchPos.y + 0.7, this._couchPos.z);
      b.rotation.y = Math.PI / 2; // facing east toward TV
      this.scene.add(b);
      this._ambient.push({ mesh: b, type: "sit", phase: 0 });
    }

    // Summer — walking the porch (back-and-forth on a path in front of house)
    {
      const s = this._makeHumanoid({ shirt: 0xff8866, hair: 0xff6b3a, skin: 0xfdd6b5 });
      const path = [
        { x: -14, z: -3 },
        { x: -6,  z: -3 },
      ];
      s.position.set(path[0].x, heightAt(path[0].x, path[0].z), path[0].z);
      this.scene.add(s);
      this._ambient.push({ mesh: s, type: "walk", path, target: 1, speed: 1.6, walkPhase: 0 });
    }

    // Squanchy — the cat, sleeping on the rug. Polygons boosted ~25x total.
    {
      const g = new THREE.Group();
      const fur = new THREE.MeshLambertMaterial({ color: 0x998866 });
      const stripe = new THREE.MeshLambertMaterial({ color: 0x665544 });
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 62, 40), fur);
      body.scale.set(1.6, 0.7, 0.9);
      body.position.y = 0.18;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 49, 40), fur);
      head.position.set(0.4, 0.22, 0);
      const ear1 = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 32), fur);
      ear1.position.set(0.45, 0.4, 0.1);
      const ear2 = ear1.clone(); ear2.position.z = -0.1;
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.5, 40, 9), stripe);
      tail.rotation.z = -Math.PI / 3; tail.position.set(-0.45, 0.25, 0);
      for (const sz of [-0.06, 0.06]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 32, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
        eye.position.set(0.52, 0.24, sz);
        g.add(eye);
      }
      g.add(body); g.add(head); g.add(ear1); g.add(ear2); g.add(tail);
      // Place on the rug (rug is at center of house)
      const houseCx = -10, houseCz = -8, houseFy = heightAt(houseCx, houseCz);
      g.position.set(houseCx + 0.2, houseFy + 0.07, houseCz - 0.4);
      g.rotation.y = 0.6;
      this.scene.add(g);
      this._ambient.push({ mesh: g, type: "sleep", phase: Math.random() * 5 });
    }

    // Snuffles — the dog, patrolling the yard. Box segment counts boosted ~25x total.
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.35, 12, 9, 9), new THREE.MeshLambertMaterial({ color: 0xc7a060 }));
      body.position.y = 0.3;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3, 9, 9, 9), new THREE.MeshLambertMaterial({ color: 0xc7a060 }));
      head.position.set(0.4, 0.45, 0);
      const ear1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.1, 5, 9, 5), new THREE.MeshLambertMaterial({ color: 0x886a30 }));
      ear1.position.set(0.42, 0.65, 0.12);
      const ear2 = ear1.clone(); ear2.position.z = -0.12;
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.06, 14, 5, 5), new THREE.MeshLambertMaterial({ color: 0xc7a060 }));
      tail.position.set(-0.45, 0.45, 0); tail.rotation.z = 0.4;
      for (const [px, pz] of [[0.25, 0.13], [0.25, -0.13], [-0.25, 0.13], [-0.25, -0.13]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.08, 5, 9, 5), new THREE.MeshLambertMaterial({ color: 0x886a30 }));
        leg.position.set(px, 0.13, pz);
        g.add(leg);
      }
      g.add(body); g.add(head); g.add(ear1); g.add(ear2); g.add(tail);
      const path = [
        { x: -4, z: 8 }, { x: 4, z: 8 }, { x: 6, z: 0 }, { x: 0, z: -6 }, { x: -6, z: 0 },
      ];
      g.position.set(path[0].x, heightAt(path[0].x, path[0].z), path[0].z);
      this.scene.add(g);
      this._ambient.push({ mesh: g, type: "walk", path, target: 1, speed: 2.4, walkPhase: 0, isDog: true });
    }
  }

  _makeHumanoid({ shirt = 0x888888, hair = 0x553322, skin = 0xfdd6b5 } = {}) {
    // Polygon counts boosted ~25x total over baseline.
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 1.4, 40, 9), new THREE.MeshLambertMaterial({ color: shirt }));
    body.position.y = 0.7;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 62, 49), new THREE.MeshLambertMaterial({ color: skin }));
    head.position.y = 1.7;
    const hairMesh = new THREE.Mesh(new THREE.SphereGeometry(0.38, 62, 40, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: hair }));
    hairMesh.position.y = 1.75;
    for (const sx of [-0.12, 0.12]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 32, 32), new THREE.MeshBasicMaterial({ color: 0x111111 }));
      e.position.set(sx, 1.75, 0.3);
      g.add(e);
    }
    g.add(body); g.add(head); g.add(hairMesh);
    return g;
  }

  _makeChest(x, y, z, lootTable) {
    const wood = new THREE.MeshLambertMaterial({ color: 0x6b3f2a, flatShading: true });
    const trim = new THREE.MeshLambertMaterial({ color: 0xc8a040 });
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.55), wood);
    base.position.y = 0.25;
    const lidGroup = new THREE.Group();
    lidGroup.position.set(0, 0.5, -0.275);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.55), wood);
    lid.position.set(0, 0.09, 0.275);
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.06), trim);
    lock.position.set(0, 0.09, 0.55);
    lidGroup.add(lid); lidGroup.add(lock);
    g.add(base); g.add(lidGroup);
    g.position.set(x, y, z);
    this.scene.add(g);
    const c = { x, z, mesh: g, lid: lidGroup, openedRot: 0, opened: false, loot: lootTable };
    this._containers.push(c);
    this.props.push({ mesh: g, type: "container", x, z, hitR: 0.6, _container: c });
    return c;
  }

  _makeTextTexture(text, fg = "#3a2418", bg = "#f0d9a8") {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 128;
    const ctx = c.getContext("2d");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = fg;
    const lines = String(text).split("\n");
    const size = lines.length === 1 ? 56 : 36;
    ctx.font = `bold ${size}px ${size > 50 ? "serif" : "monospace"}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const lineH = size * 1.2;
    const startY = c.height / 2 - ((lines.length - 1) * lineH) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], c.width / 2, startY + i * lineH);
    }
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

  _placeWordWalls() {
    // Three glowing slabs at zone-edges. Activating one grants a shout slot.
    this.wordWalls = [];
    const positions = [
      { x: 200, z: 90,   word: "MORTY",   color: 0x97ce4c },
      { x: -180, z: -120, word: "RIGGITY", color: 0x5dffd1 },
      { x: 100, z: -180, word: "WUBBA",   color: 0xffd166 },
    ];
    for (const p of positions) {
      const y = heightAt(p.x, p.z);
      const g = new THREE.Group();
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(4, 4, 0.6),
        new THREE.MeshLambertMaterial({ color: 0x33323a, flatShading: true })
      );
      slab.position.y = 2;
      // Glowing carved word
      const tex = this._makeTextTexture(p.word, "#000000", `#${p.color.toString(16).padStart(6, "0")}`);
      const front = new THREE.Mesh(
        new THREE.PlaneGeometry(3.6, 1.6),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true })
      );
      front.position.set(0, 2.4, 0.31);
      const torch = new THREE.PointLight(p.color, 1.6, 14, 2);
      torch.position.y = 3;
      g.add(slab); g.add(front); g.add(torch);
      g.position.set(p.x, y, p.z);
      this.scene.add(g);
      this.wordWalls.push({ x: p.x, y, z: p.z, mesh: g, word: p.word, color: p.color, activated: false });
    }
  }

  // Weather: tick the state machine and update fog / particles.
  _updateWeather(dt, cameraPos) {
    this.weatherTimer -= dt;
    this._weatherJustChanged = false;
    if (this.weatherTimer <= 0) {
      this.weatherIndex = (this.weatherIndex + 1 + Math.floor(Math.random() * (WEATHERS.length - 1))) % WEATHERS.length;
      this.weatherTimer = 90 + Math.random() * 90;       // 1.5-3 min per state
      this._weatherJustChanged = true;
    }
    const w = this.weatherDef();
    // Fog ramps toward weather target
    if (this.scene.fog) {
      this.scene.fog.color.lerp(new THREE.Color(w.fog), Math.min(1, dt * 0.6));
      this.scene.fog.far += (w.fogFar - this.scene.fog.far) * Math.min(1, dt * 0.4);
    }
    // Rain / snow particles around the player
    if (cameraPos && (w.particles === "acid" || w.particles === "snow" || w.particles === "storm")) {
      // Spawn a few particles each frame
      const spawn = w.particles === "snow" ? 3 : 6;
      for (let i = 0; i < spawn; i++) {
        const px = cameraPos.x + (Math.random() - 0.5) * 80;
        const pz = cameraPos.z + (Math.random() - 0.5) * 80;
        const py = 30 + Math.random() * 8;
        const isSnow = w.particles === "snow";
        const color = w.particles === "acid" ? 0x96b070 : w.particles === "storm" ? 0xc89aff : 0xffffff;
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(isSnow ? 0.07 : 0.04, 4, 3),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })
        );
        m.position.set(px, py, pz);
        this.scene.add(m);
        this.weatherParticles.push({ mesh: m, vy: isSnow ? -1.5 : -8, life: 0, ttl: 4 });
      }
    }
    for (let i = this.weatherParticles.length - 1; i >= 0; i--) {
      const p = this.weatherParticles[i];
      p.life += dt;
      p.mesh.position.y += p.vy * dt;
      if (p.life > p.ttl || p.mesh.position.y < heightAt(p.mesh.position.x, p.mesh.position.z)) {
        this.scene.remove(p.mesh);
        this.weatherParticles.splice(i, 1);
      }
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
    // Weather first (modifies fog, spawns particles)
    this._updateWeather(dt, cameraPos);
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
    // Front door swings open when player is close to the doorway
    if (this._smithDoor && cameraPos) {
      const d = Math.hypot(cameraPos.x - this._smithDoor.x, cameraPos.z - this._smithDoor.z);
      this._smithDoor.target = d < 4 ? -Math.PI * 0.55 : 0;
      const k = 6 * dt;
      this._smithDoor.current += (this._smithDoor.target - this._smithDoor.current) * Math.min(1, k);
      this._smithDoor.hinge.rotation.y = this._smithDoor.current;
    }

    // Ceiling fan rotation
    if (this._smithFan) {
      this._smithFan.rotor.rotation.y += dt * 4.0;
    }

    // Garage exhaust fan blades spin
    if (this._smithExhaust) {
      this._smithExhaust.rotation.z += dt * 8;
    }

    // Smoke detector LED blink
    if (this._smithSmokeLED) {
      const blink = (Math.sin(t * 1.6) > 0.95) ? 1.0 : 0.15;
      this._smithSmokeLED.color.setRGB(1.0 * blink, 0.18 * blink, 0.22 * blink);
    }

    // Holographic molecule — rotate nucleus + orbit electrons on tilted rings
    if (this._smithHolo) {
      const h = this._smithHolo;
      h.t += dt;
      h.holo.rotation.y = h.t * 0.6;
      h.nucleus.rotation.y = h.t * 1.6;
      h.nucleus.rotation.x = h.t * 0.9;
      const r = 0.32;
      for (const e of h.electrons) {
        const a = h.t * 2.5 + e.baseAng;
        const ex = Math.cos(a) * r;
        const ey = Math.sin(a) * r * (e.tiltAxis === 0 ? 0.4 : 1);
        const ez = Math.sin(a) * r * (e.tiltAxis === 1 ? 0.4 : 1);
        e.mesh.position.set(ex, ey, ez);
      }
    }

    // Patrol drone — fly along path with rotor spin and gentle bobbing
    if (this._smithDrone) {
      const dr = this._smithDrone;
      const tgt = dr.path[dr.target];
      const dx = tgt.x - dr.mesh.position.x, dz = tgt.z - dr.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.4) {
        dr.target = (dr.target + 1) % dr.path.length;
      } else {
        const nx = dx / dist, nz = dz / dist;
        dr.mesh.position.x += nx * dr.speed * dt;
        dr.mesh.position.z += nz * dr.speed * dt;
        dr.mesh.rotation.y = Math.atan2(nx, nz);
      }
      dr.t += dt;
      dr.mesh.position.y = 3.0 + Math.sin(dr.t * 2) * 0.25;
      dr.rotors.rotation.y += dt * 18;
      // Eye blink-pulse
      const k = 0.6 + 0.4 * Math.sin(dr.t * 3);
      dr.eye.material.color.setRGB(0.3 * k, 1.0 * k, 0.5 * k);
    }

    // Beaker bubbles — rise from each beaker's liquid surface
    if (this._smithBeakers) {
      for (const b of this._smithBeakers) {
        b.t -= dt;
        if (b.t <= 0) {
          b.t = 0.25 + Math.random() * 0.4;
          const mat = new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.9 });
          const m = new THREE.Mesh(new THREE.SphereGeometry(0.04 + Math.random() * 0.04, 6, 5), mat);
          m.position.set(b.x + (Math.random() - 0.5) * 0.05, b.y, b.z + (Math.random() - 0.5) * 0.05);
          this.scene.add(m);
          this._smithBeakers.bubblePool.push({ mesh: m, mat, vy: 0.4 + Math.random() * 0.4, life: 0, ttl: 1.0 });
        }
      }
      const pool = this._smithBeakers.bubblePool;
      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i];
        p.life += dt;
        p.mesh.position.y += p.vy * dt;
        p.mat.opacity = Math.max(0, 0.9 * (1 - p.life / p.ttl));
        if (p.life >= p.ttl) {
          this.scene.remove(p.mesh);
          pool.splice(i, 1);
        }
      }
    }

    // CRT screen subtle flicker
    if (this._smithCRT) {
      const k = 0.8 + 0.2 * Math.sin(t * 18 + Math.sin(t * 3) * 4);
      this._smithCRT.light.intensity = 0.3 + k * 0.25;
      // subtle color shift on the screen (bias green channel)
      const c = this._smithCRT.mat.color;
      c.setRGB(0.05 + 0.05 * k, 0.85 + 0.15 * k, 0.6 + 0.15 * k);
    }

    // TV screen flicker
    if (this._smithTV) {
      const k = 0.4 + 0.6 * Math.abs(Math.sin(t * 8 + Math.sin(t * 2.3) * 3));
      const r = (k * 0.5 + 0.3), g = (k * 0.7 + 0.2), b = (k * 0.9 + 0.4);
      this._smithTV.mat.color.setRGB(Math.min(1, r), Math.min(1, g), Math.min(1, b));
    }

    // Container lid animations
    for (const c of this._containers || []) {
      const target = c.opened ? -1.2 : 0;
      const k = 8 * dt;
      c.openedRot += (target - c.openedRot) * Math.min(1, k);
      c.lid.rotation.x = c.openedRot;
    }

    // Ambient characters
    if (this._ambient) {
      for (const a of this._ambient) {
        if (a.type === "sit") {
          a.phase += dt;
          a.mesh.position.y = (a.mesh.userData.baseY ??= a.mesh.position.y) + Math.sin(a.phase * 1.4) * 0.02;
          a.mesh.rotation.y += Math.sin(a.phase * 0.8) * dt * 0.3;
        } else if (a.type === "sleep") {
          // Cat breathing — scale belly slightly + subtle tail twitch
          a.phase += dt;
          const k = 1 + Math.sin(a.phase * 1.1) * 0.04;
          a.mesh.scale.set(k, k, k);
          // Tail is the 4th-to-last child added; safely twitch the whole mesh slightly
          a.mesh.rotation.z = Math.sin(a.phase * 0.6) * 0.04;
        } else if (a.type === "walk") {
          const tgt = a.path[a.target];
          const dx = tgt.x - a.mesh.position.x, dz = tgt.z - a.mesh.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.3) {
            a.target = (a.target + 1) % a.path.length;
          } else {
            const nx = dx / dist, nz = dz / dist;
            a.mesh.position.x += nx * a.speed * dt;
            a.mesh.position.z += nz * a.speed * dt;
            a.mesh.position.y = heightAt(a.mesh.position.x, a.mesh.position.z) + (a.isDog ? 0 : 0);
            a.mesh.rotation.y = Math.atan2(nx, nz);
          }
          a.walkPhase += dt * a.speed;
          a.mesh.position.y += Math.abs(Math.sin(a.walkPhase * 4)) * 0.05;
          if (a.isDog) {
            // wag tail (rotate the last child added — tail is index 4 in our group)
            // We'll just bob the dog slightly
          }
        }
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
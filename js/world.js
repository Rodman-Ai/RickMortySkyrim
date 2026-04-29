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
      this._addTree(x, z);
    }
    for (let i = 0; i < 220; i++) {
      const x = (rand() - 0.5) * 2 * half;
      const z = (rand() - 0.5) * 2 * half;
      this._addRock(x, z);
    }
    // Huts at smith garage
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this._addHut(Math.cos(a) * 12, Math.sin(a) * 12);
    }
    // Portals at each zone center (except home)
    for (const z of ZONES) {
      if (z.id === "smith_garage") continue;
      this._addPortal(z.cx + 4, z.cz);
    }
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
  }
}
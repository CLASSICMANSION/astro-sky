// ============================================================================
// sky.js — the live cosmic dashboard. Wires together:
//   astro.js (math)  ->  device sensors (where you're looking / where you are)
//   ->  a WebGL scene rendered with bloom, twinkling shaders and glow sprites.
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import {
  lstDeg, raDecToAltAz, sunPosition, moonPosition, planetPosition,
  STARS, CONSTELLATION_LINES, CLUSTERS, deg2rad, rad2deg, norm360, galacticLatitude
} from './astro.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const el = {
  start: $('start'), launch: $('launch'), status: $('status-line'),
  fallbackSky: $('fallback-sky'), canvas: $('gl-canvas'),
  locVal: $('loc-val'), locPlace: $('loc-place'), lstVal: $('lst-val'), timeVal: $('time-val'),
  targetCard: $('target-card'), targetName: $('target-name'), targetMeta: $('target-meta'),
  compassTrack: $('compass-track'),
  pillSensor: $('pill-sensor'), pillCalibrate: $('pill-calibrate'),
  objlistBtn: $('objlist-btn'), objlist: $('objlist'),
  panel: $('panel'), closePanel: $('close-panel'), pName: $('p-name'), pSub: $('p-sub'), pGrid: $('p-grid'),
  manualLoc: $('manual-loc'), manLat: $('man-lat'), manLon: $('man-lon'), manGo: $('man-go'),
  altTrack: $('alt-track'), altMarker: $('alt-marker'), altReadout: $('alt-readout'),
  compassToggle: $('compass-toggle'), compassDial: $('compass-dial'), compassFace: $('compass-face'),
  compassDots: $('compass-dots'),
  compassDegCenter: $('compass-deg-center'), compassDirCenter: $('compass-dir-center'),
  headingBig: $('heading-big'), zoomPill: $('zoom-pill'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const SKY_RADIUS = 400;
const DEFAULT_FOV = 62, MIN_FOV = 4, MAX_FOV = 75; // MIN_FOV ~15x magnification — enough to study a planet's disc

const state = {
  lat: null, lon: null, hasLocation: false,
  headingOffset: 0,          // manual calibration nudge, degrees
  useSensors: false,
  dragYaw: 0, dragPitch: 0,  // fallback control
  dragging: false, lastX: 0, lastY: 0,
  pinching: false,
  targetFov: DEFAULT_FOV, // animated toward each frame, so zoom eases rather than snapping
  currentAz: 0, currentAlt: 0, // where the crosshair currently points
  bodies: [],                // live celestial bodies (planets/sun/moon)
  starAltAz: [],              // cached per-frame alt/az for stars
};

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, window.innerWidth / window.innerHeight, 0.1, 2000);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const afterimage = new AfterimagePass(0.4); // subtle motion smoothing, not a heavy trail
composer.addPass(afterimage);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.15, 0.65, 0.12);
composer.addPass(bloom);
const smaa = new SMAAPass(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
composer.addPass(smaa);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  smaa.setSize(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
});

// ---------------------------------------------------------------------------
// Helpers: alt/az -> world position on the sky sphere.
// Convention: +X = East, +Y = Up (zenith), -Z = North (matches the standard
// device-orientation-to-quaternion recipe used below).
// ---------------------------------------------------------------------------
function altAzToVec3(altDeg, azDeg, radius) {
  const alt = deg2rad(altDeg), az = deg2rad(azDeg);
  const x = radius * Math.cos(alt) * Math.sin(az);
  const y = radius * Math.sin(alt);
  const z = -radius * Math.cos(alt) * Math.cos(az);
  return new THREE.Vector3(x, y, z);
}

function angularSeparationDeg(alt1, az1, alt2, az2) {
  const a1 = deg2rad(alt1), a2 = deg2rad(alt2), dAz = deg2rad(az1 - az2);
  const cosC = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dAz);
  return Math.acos(THREE.MathUtils.clamp(cosC, -1, 1)) * (180 / Math.PI);
}

// ---------------------------------------------------------------------------
// Glow sprite texture generator (canvas -> texture), tinted per body
// ---------------------------------------------------------------------------
function makeGlowTexture(hex) {
  const size = 512;
  const cnv = document.createElement('canvas'); cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  const c = new THREE.Color(hex);
  const rgb = `${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)}`;
  const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  grad.addColorStop(0.0,  `rgba(255,255,255,1)`);
  grad.addColorStop(0.06, `rgba(255,255,255,0.95)`);
  grad.addColorStop(0.16, `rgba(${rgb},0.9)`);
  grad.addColorStop(0.32, `rgba(${rgb},0.55)`);
  grad.addColorStop(0.55, `rgba(${rgb},0.22)`);
  grad.addColorStop(0.8,  `rgba(${rgb},0.06)`);
  grad.addColorStop(1.0,  `rgba(${rgb},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cnv);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Starfield — real bright stars + procedural filler, GPU-twinkled
// ---------------------------------------------------------------------------
const twinkleVertex = `
  attribute float size;
  attribute float phase;
  attribute vec3 customColor;
  varying vec3 vColor;
  varying float vPhase;
  uniform float uTime;
  void main() {
    vColor = customColor;
    vPhase = sin(uTime * 1.6 + phase) * 0.5 + 0.5;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mv.z) * (0.65 + 0.35 * vPhase);
    gl_Position = projectionMatrix * mv;
  }
`;
const twinkleFragment = `
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(1.0, 0.0, d * 6.0);
    float halo = pow(smoothstep(1.0, 0.0, d), 2.2);
    float glow = clamp(core + halo * 0.65, 0.0, 1.0);
    vec3 col = vColor * (0.55 + 0.45 * vPhase) + core * 0.4;
    gl_FragColor = vec4(col, glow);
  }
`;

const NUM_FILLER = 9000;

// Procedurally seed a dense background starfield, but weighted by real
// galactic latitude so the Milky Way band falls where it actually is in
// the sky — not just decorative noise.
function generateFillerStars(target) {
  const list = [];
  let attempts = 0;
  const maxAttempts = target * 25;
  while (list.length < target && attempts < maxAttempts) {
    attempts++;
    const raDeg = Math.random() * 360;
    const decDeg = Math.asin(2 * Math.random() - 1) * (180 / Math.PI);
    const b = galacticLatitude(raDeg, decDeg);
    const bandWeight = Math.exp(-(b * b) / (2 * 8 * 8));
    const acceptProb = 0.05 + 0.95 * bandWeight;
    if (Math.random() < acceptProb) {
      const mag = 3.3 + Math.random() * Math.random() * 3.2; // skewed faint, a rare brighter one
      list.push([null, raDeg / 15, decDeg, mag]);
    }
  }
  return list;
}
const ALL_STARS = STARS.concat(generateFillerStars(NUM_FILLER));

const totalStars = ALL_STARS.length;
const starGeo = new THREE.BufferGeometry();
const starPos = new Float32Array(totalStars * 3);
const starSize = new Float32Array(totalStars);
const starPhase = new Float32Array(totalStars);
const starColor = new Float32Array(totalStars * 3);

function magToSize(mag) { return THREE.MathUtils.clamp(6.2 - mag * 1.05, 1.2, 9); }
function starTint(seedIdx) {
  const palette = [0x9fc7ff, 0xd7e6ff, 0xffffff, 0xfff2d6, 0xffd9a0];
  return new THREE.Color(palette[seedIdx % palette.length]);
}

for (let i = 0; i < totalStars; i++) {
  const mag = ALL_STARS[i][3];  starSize[i] = magToSize(mag);
  starPhase[i] = Math.random() * Math.PI * 2;
  const c = starTint(i);
  starColor[i*3] = c.r; starColor[i*3+1] = c.g; starColor[i*3+2] = c.b;
}

starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
starGeo.setAttribute('size', new THREE.BufferAttribute(starSize, 1));
starGeo.setAttribute('phase', new THREE.BufferAttribute(starPhase, 1));
starGeo.setAttribute('customColor', new THREE.BufferAttribute(starColor, 3));

const starMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  vertexShader: twinkleVertex, fragmentShader: twinkleFragment,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const starPoints = new THREE.Points(starGeo, starMat);
scene.add(starPoints);

// Constellation lines — built once, positions refreshed each recompute cycle
const nameIndex = new Map(STARS.map((s, i) => [s[0], i]));
const lineSegPairs = [];
for (const [, pairs] of CONSTELLATION_LINES) {
  for (const [a, b] of pairs) {
    if (nameIndex.has(a) && nameIndex.has(b)) lineSegPairs.push([nameIndex.get(a), nameIndex.get(b)]);
  }
}
const lineGeo = new THREE.BufferGeometry();
const linePos = new Float32Array(lineSegPairs.length * 2 * 3);
lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
const lineMat = new THREE.LineBasicMaterial({ color: 0x6fa8ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending });
const constellationLines = new THREE.LineSegments(lineGeo, lineMat);
scene.add(constellationLines);

// ---------------------------------------------------------------------------
// Star name labels + constellation name labels + cluster label — all
// positioned by real RA/Dec and refreshed alongside the star field.
// ---------------------------------------------------------------------------
function makeTextSprite(text, opts = {}) {
  const { color = '#e9edfb', size = 44, spaced = false, weight = 500, glow = 0 } = opts;
  const label = spaced ? text.toUpperCase().split('').join('\u2009') : text;
  const cnv = document.createElement('canvas');
  const ctx0 = cnv.getContext('2d');
  ctx0.font = `${weight} ${size}px 'JetBrains Mono', monospace`;
  const w = Math.ceil(ctx0.measureText(label).width) + 40;
  const h = size * 1.8;
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d');
  ctx.font = `${weight} ${size}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (glow > 0) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  ctx.fillText(label, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(cnv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = w / h;
  sprite.userData.aspect = aspect;
  return sprite;
}

// Bright named stars get a small label offset to the upper-right of the dot.
const STAR_LABEL_MAG_LIMIT = 1.9;
const starLabels = []; // { index, sprite }
for (let i = 0; i < STARS.length; i++) {
  const [name, , , mag] = STARS[i];
  if (mag > STAR_LABEL_MAG_LIMIT) continue;
  const c = starTint(i);
  const sprite = makeTextSprite(name, { color: '#' + c.getHexString(), size: 30, weight: 500 });
  sprite.scale.set(9 * sprite.userData.aspect, 9, 1);
  scene.add(sprite);
  starLabels.push({ index: i, sprite });
}

// Constellation labels — letter-spaced, positioned at the (vector) average
// of each figure's member stars, refreshed live just like any other body.
const constellationLabels = []; // { raH, dec, sprite }
for (const [name, pairs] of CONSTELLATION_LINES) {
  const names = new Set();
  for (const [a, b] of pairs) { names.add(a); names.add(b); }
  let x = 0, y = 0, z = 0, n = 0;
  for (const sn of names) {
    const idx = nameIndex.get(sn); if (idx === undefined) continue;
    const [, raH, dec] = STARS[idx];
    const ra = deg2rad(raH * 15), de = deg2rad(dec);
    x += Math.cos(de) * Math.cos(ra); y += Math.cos(de) * Math.sin(ra); z += Math.sin(de);
    n++;
  }
  if (n === 0) continue;
  x /= n; y /= n; z /= n;
  const dec = rad2deg(Math.asin(THREE.MathUtils.clamp(z, -1, 1)));
  const raH = norm360(rad2deg(Math.atan2(y, x))) / 15;
  const sprite = makeTextSprite(name, { color: '#6f88c9', size: 26, spaced: true, weight: 400 });
  sprite.material.opacity = 0.6;
  sprite.scale.set(13 * sprite.userData.aspect, 13, 1);
  scene.add(sprite);
  constellationLabels.push({ raH, dec, sprite });
}

// Cluster labels (e.g. the Pleiades)
const clusterLabels = [];
for (const [name, members] of CLUSTERS) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const sn of members) {
    const idx = nameIndex.get(sn); if (idx === undefined) continue;
    const [, raH, dec] = STARS[idx];
    const ra = deg2rad(raH * 15), de = deg2rad(dec);
    x += Math.cos(de) * Math.cos(ra); y += Math.cos(de) * Math.sin(ra); z += Math.sin(de);
    n++;
  }
  if (n === 0) continue;
  x /= n; y /= n; z /= n;
  const dec = rad2deg(Math.asin(THREE.MathUtils.clamp(z, -1, 1)));
  const raH = norm360(rad2deg(Math.atan2(y, x))) / 15;
  const sprite = makeTextSprite(name, { color: '#bcd7ff', size: 26, weight: 500, glow: 8 });
  sprite.scale.set(11 * sprite.userData.aspect, 11, 1);
  scene.add(sprite);
  clusterLabels.push({ raH, dec, sprite });
}

// Diffraction-spike sparkle for the very brightest stars (mag < 0) — a
// photographic touch real cameras/eyes produce for dazzling point sources.
function makeSpikeTexture(hex) {
  const size = 256, c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(hex);
  const rgb = `${Math.round(col.r*255)},${Math.round(col.g*255)},${Math.round(col.b*255)}`;
  const cx = size / 2, cy = size / 2;
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.14);
  core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = core; ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  for (const angle of [0, 90]) {
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(deg2rad(angle));
    const spike = ctx.createLinearGradient(-cx, 0, cx, 0);
    spike.addColorStop(0, `rgba(${rgb},0)`); spike.addColorStop(0.5, `rgba(255,255,255,0.9)`); spike.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = spike; ctx.fillRect(-cx, -1.4, size, 2.8);
    ctx.restore();
  }
  return new THREE.CanvasTexture(c);
}
const SPARKLE_MAG_LIMIT = 0;
const sparkleStars = [];
for (let i = 0; i < STARS.length; i++) {
  if (STARS[i][3] > SPARKLE_MAG_LIMIT) continue;
  const c = starTint(i);
  const mat = new THREE.SpriteMaterial({ map: makeSpikeTexture('#' + c.getHexString()), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(26, 26, 1);
  scene.add(sprite);
  sparkleStars.push({ index: i, sprite });
}

// ---------------------------------------------------------------------------
// Milky Way haze — soft warm glow points, density-weighted the same way as
// the background starfield, layered in to read as visible nebulosity.
// ---------------------------------------------------------------------------
const hazeStars = generateFillerStars(1400).filter(s => Math.abs(galacticLatitude(s[1]*15, s[2])) < 9);
const hazeGeo = new THREE.BufferGeometry();
const hazePos = new Float32Array(hazeStars.length * 3);
hazeGeo.setAttribute('position', new THREE.BufferAttribute(hazePos, 3));
const hazeTex = makeGlowTexture(0xd9b98a);
const hazeMat = new THREE.PointsMaterial({
  size: 14, map: hazeTex, color: 0xd9b98a, transparent: true, opacity: 0.10,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
});
const hazePoints = new THREE.Points(hazeGeo, hazeMat);
scene.add(hazePoints);

// ---------------------------------------------------------------------------
// Celestial bodies: Sun, Moon, five naked-eye planets
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Procedural surface textures for planet/Moon spheres — no external image
// assets, generated once at load time.
// ---------------------------------------------------------------------------
function makeCraterTexture(baseHex, shadowHex) {
  const size = 512;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseHex; ctx.fillRect(0, 0, size, size);
  // Maria (large dark patches)
  for (let i = 0; i < 9; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 30 + Math.random() * 70;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, shadowHex + 'aa'); g.addColorStop(1, shadowHex + '00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Small craters
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 2 + Math.random() * 9;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

function makeBandedTexture(bandColors) {
  const w = 512, h = 256;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const n = bandColors.length;
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const idx = Math.min(n - 1, Math.floor(t * n));
    const nextIdx = Math.min(n - 1, idx + 1);
    const localT = (t * n) - idx;
    const c1 = new THREE.Color(bandColors[idx]), c2 = new THREE.Color(bandColors[nextIdx]);
    const mix = c1.clone().lerp(c2, localT);
    ctx.fillStyle = `rgb(${mix.r*255|0},${mix.g*255|0},${mix.b*255|0})`;
    ctx.fillRect(0, y, w, 1);
  }
  // subtle turbulence
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = 4 + Math.random() * 14;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`; ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

function makeRockyTexture(baseHex, spotHex) {
  const size = 512;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseHex; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 3 + Math.random() * 22;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, spotHex + '55'); g.addColorStop(1, spotHex + '00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

function makeSunTexture() {
  const size = 512;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const base = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  base.addColorStop(0, '#fff3d0'); base.addColorStop(0.6, '#ffcf6b'); base.addColorStop(1, '#ff9a3c');
  ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 2 + Math.random() * 8;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,${140 + Math.random()*80|0},${20 + Math.random()*40|0},${0.12 + Math.random()*0.15})`;
    ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

function makeLitSphere(radius, lightDir, texture) {
  const geo = new THREE.SphereGeometry(radius, 48, 48);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uLightDir: { value: lightDir.clone() }, uMap: { value: texture } },
    vertexShader: `
      varying vec3 vNormal; varying vec2 vUv;
      void main(){
        vNormal = normalize(normalMatrix * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal; varying vec2 vUv;
      uniform vec3 uLightDir; uniform sampler2D uMap;
      void main(){
        vec3 base = texture2D(uMap, vUv).rgb;
        float lit = max(dot(normalize(vNormal), normalize(uLightDir)), 0.0);
        lit = pow(lit, 0.5) * 0.85 + 0.15;
        gl_FragColor = vec4(base * lit, 1.0);
      }
    `
  });
  return new THREE.Mesh(geo, mat);
}

const BODY_DEFS = [
  { key: 'sun', name: 'Sun', color: 0xffd27a, size: 46, kind: 'sun', coreRadius: 10 },
  { key: 'moon', name: 'Moon', color: 0xe9edf6, size: 30, kind: 'moon', coreRadius: 7 },
  { key: 'mercury', name: 'Mercury', color: 0xc9c2b8, size: 16, kind: 'rocky', coreRadius: 3.4,
    base: '#9c948a', spot: '#5b544c' },
  { key: 'venus', name: 'Venus', color: 0xffe9c4, size: 20, kind: 'rocky', coreRadius: 4.4,
    base: '#e8cf9e', spot: '#c9a86a' },
  { key: 'mars', name: 'Mars', color: 0xff8a5c, size: 17, kind: 'rocky', coreRadius: 3.8,
    base: '#b8583a', spot: '#7a3320' },
  { key: 'jupiter', name: 'Jupiter', color: 0xf3d9a8, size: 22, kind: 'bands', coreRadius: 7.5,
    bands: ['#c9a878', '#e8d3ab', '#b8895a', '#e0c194', '#a8794f', '#ecdcb8'] },
  { key: 'saturn', name: 'Saturn', color: 0xf1e2b0, size: 20, kind: 'bands', coreRadius: 6.5,
    bands: ['#e8d9a8', '#f0e6c0', '#d8c68f', '#ede0b5'], ring: true },
  { key: 'uranus', name: 'Uranus', color: 0xa8e8e8, size: 14, kind: 'bands', coreRadius: 5,
    bands: ['#a8e0e0', '#c5eeee'] },
  { key: 'neptune', name: 'Neptune', color: 0x6f8cff, size: 14, kind: 'bands', coreRadius: 5,
    bands: ['#5a78e8', '#7d99f2'] },
];

for (const def of BODY_DEFS) {
  const tex = makeGlowTexture(def.color);
  const mat = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(def.size, def.size, 1);
  scene.add(sprite);

  let core = null, ring = null;
  const sunDir = new THREE.Vector3(1, 0, 0);
  if (def.kind === 'sun') {
    const geo = new THREE.SphereGeometry(def.coreRadius, 48, 48);
    const sunMat = new THREE.MeshBasicMaterial({ map: makeSunTexture() });
    core = new THREE.Mesh(geo, sunMat);
  } else if (def.kind === 'moon') {
    core = makeLitSphere(def.coreRadius, sunDir, makeCraterTexture('#d9d4c8', '#4a463e'));
  } else if (def.kind === 'rocky') {
    core = makeLitSphere(def.coreRadius, sunDir, makeRockyTexture(def.base, def.spot));
  } else if (def.kind === 'bands') {
    core = makeLitSphere(def.coreRadius, sunDir, makeBandedTexture(def.bands));
    if (def.ring) {
      const ringGeo = new THREE.RingGeometry(def.coreRadius * 1.5, def.coreRadius * 2.4, 64);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xd8c68f, side: THREE.DoubleSide, transparent: true, opacity: 0.75 });
      ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2.4;
    }
  }
  if (core) scene.add(core);
  if (ring) scene.add(ring);
  state.bodies.push({ ...def, sprite, core, ring });
}

// ---------------------------------------------------------------------------
// Ground plane, horizon ring & cardinal markers — makes "up" vs "down"
// (and which way you're facing) unmistakable inside the 3D view itself.
// ---------------------------------------------------------------------------
{
  // Ground disc: a warm, dim gradient fading away from the horizon, clearly
  // distinct from the cool dark sky above it.
  const groundCnv = document.createElement('canvas');
  groundCnv.width = groundCnv.height = 512;
  const gctx = groundCnv.getContext('2d');
  const gGrad = gctx.createRadialGradient(256, 256, 0, 256, 256, 256);
  gGrad.addColorStop(0.0, 'rgba(40,32,24,0.95)');
  gGrad.addColorStop(0.35, 'rgba(20,16,14,0.9)');
  gGrad.addColorStop(1.0, 'rgba(5,5,8,0.98)');
  gctx.fillStyle = gGrad;
  gctx.fillRect(0, 0, 512, 512);
  const groundTex = new THREE.CanvasTexture(groundCnv);
  const groundGeo = new THREE.CircleGeometry(SKY_RADIUS * 0.999, 64);
  const groundMat = new THREE.MeshBasicMaterial({ map: groundTex, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = Math.PI / 2;
  ground.position.y = -0.5;
  scene.add(ground);

  // Horizon ring: a bright thin line exactly at altitude 0.
  const ringPts = [];
  for (let a = 0; a <= 360; a += 2) ringPts.push(altAzToVec3(0, a, SKY_RADIUS * 0.995));
  const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
  const ringMat = new THREE.LineBasicMaterial({ color: 0x4fe3d4, transparent: true, opacity: 0.35 });
  scene.add(new THREE.LineLoop(ringGeo, ringMat));

  // Faint altitude reference circles at 30°/60°, for depth — a subtle alt-az grid.
  for (const altDeg of [30, 60]) {
    const pts = [];
    for (let a = 0; a <= 360; a += 4) pts.push(altAzToVec3(altDeg, a, SKY_RADIUS * 0.995));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.LineBasicMaterial({ color: 0x6f88c9, transparent: true, opacity: 0.08 });
    scene.add(new THREE.LineLoop(g, m));
  }

  // Atmospheric horizon glow — a soft additive band hugging the horizon all
  // the way around, like light pollution / dusk airglow.
  const glowCnv = document.createElement('canvas');
  glowCnv.width = 32; glowCnv.height = 256;
  const glCtx = glowCnv.getContext('2d');
  const glGrad = glCtx.createLinearGradient(0, 0, 0, 256);
  glGrad.addColorStop(0.0, 'rgba(79,227,212,0)');
  glGrad.addColorStop(0.48, 'rgba(255,180,120,0.16)');
  glGrad.addColorStop(0.5, 'rgba(255,210,160,0.30)');
  glGrad.addColorStop(0.52, 'rgba(120,160,255,0.14)');
  glGrad.addColorStop(1.0, 'rgba(79,227,212,0)');
  glCtx.fillStyle = glGrad; glCtx.fillRect(0, 0, 32, 256);
  const glowTex = new THREE.CanvasTexture(glowCnv);
  const glowGeo = new THREE.CylinderGeometry(SKY_RADIUS * 0.97, SKY_RADIUS * 0.97, 90, 64, 1, true);
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const horizonGlow = new THREE.Mesh(glowGeo, glowMat);
  scene.add(horizonGlow);

  // Cardinal letters, fixed in real compass directions.
  function makeLabelSprite(text, color) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.font = '600 64px JetBrains Mono, monospace';
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = color; ctx.shadowBlur = 18;
    ctx.fillText(text, 64, 68);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    return new THREE.Sprite(mat);
  }
  const cardinals = [['N', 0, '#4fe3d4', 16], ['E', 90, '#e9edfb', 11], ['S', 180, '#e9edfb', 11], ['W', 270, '#e9edfb', 11]];
  for (const [label, az, color, size] of cardinals) {
    const spr = makeLabelSprite(label, color);
    spr.position.copy(altAzToVec3(1.5, az, SKY_RADIUS * 0.98));
    spr.scale.set(size, size, 1);
    scene.add(spr);
  }
}

// ---------------------------------------------------------------------------
// Ambient cosmic dust particles (pure atmosphere, not astronomically mapped)
// ---------------------------------------------------------------------------
{
  const N = 700;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 180 + Math.random() * 200; // pushed well back so it reads as atmosphere, not foreground clutter
    const theta = Math.random() * Math.PI * 2, phi = Math.random() * Math.PI;
    pos[i*3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i*3+1] = r * Math.cos(phi) * 0.4 + 20;
    pos[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dustTex = makeGlowTexture(0x8b7bff);
  const mat = new THREE.PointsMaterial({
    size: 2.2, map: dustTex, color: 0x8b7bff, transparent: true, opacity: 0.28,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const dust = new THREE.Points(geo, mat);
  scene.add(dust);
  state.dust = dust;
}

// ---------------------------------------------------------------------------
// Astronomical recompute (throttled — the sky moves slowly)
// ---------------------------------------------------------------------------
function recomputeSky() {
  if (!state.hasLocation) return;
  const now = new Date();
  const lst = lstDeg(now, state.lon);

  el.timeVal.textContent = now.toISOString().substring(11, 19) + ' Z';
  el.lstVal.textContent = (lst / 15).toFixed(2) + 'h';
  el.locVal.textContent = `${state.lat.toFixed(3)}°, ${state.lon.toFixed(3)}°`;

  // Stars (named + procedural background, all positioned by real RA/Dec)
  const positions = starGeo.attributes.position.array;
  state.starAltAz.length = 0;
  for (let i = 0; i < totalStars; i++) {
    const [name, raH, dec, mag] = ALL_STARS[i];
    const aa = raDecToAltAz(raH * 15, dec, state.lat, lst);
    const v = altAzToVec3(aa.alt, aa.az, SKY_RADIUS);
    positions[i*3] = v.x; positions[i*3+1] = v.y; positions[i*3+2] = v.z;
    if (name) state.starAltAz.push({ name, alt: aa.alt, az: aa.az, mag, lightYears: ALL_STARS[i][4], kind: 'star' });
  }
  starGeo.attributes.position.needsUpdate = true;

  // Constellation line endpoints
  const lp = lineGeo.attributes.position.array;
  for (let i = 0; i < lineSegPairs.length; i++) {
    const [a, b] = lineSegPairs[i];
    lp[i*6]   = positions[a*3];   lp[i*6+1] = positions[a*3+1]; lp[i*6+2] = positions[a*3+2];
    lp[i*6+3] = positions[b*3];   lp[i*6+4] = positions[b*3+1]; lp[i*6+5] = positions[b*3+2];
  }
  lineGeo.attributes.position.needsUpdate = true;

  // Diffraction-spike sparkle for the very brightest stars
  for (const { index, sprite } of sparkleStars) {
    const [, raH, dec] = STARS[index];
    const aa = raDecToAltAz(raH * 15, dec, state.lat, lst);
    sprite.position.copy(altAzToVec3(aa.alt, aa.az, SKY_RADIUS * 0.995));
    sprite.material.opacity = aa.alt > -2 ? THREE.MathUtils.clamp((aa.alt + 2) / 8, 0, 1) : 0;
  }

  // Star name labels — offset slightly in azimuth so they sit beside the dot
  for (const { index, sprite } of starLabels) {
    const [, raH, dec] = STARS[index];
    const aa = raDecToAltAz(raH * 15, dec, state.lat, lst);
    const cosAlt = Math.max(Math.cos(deg2rad(aa.alt)), 0.2);
    const v = altAzToVec3(aa.alt, aa.az + 1.1 / cosAlt, SKY_RADIUS * 0.99);
    sprite.position.copy(v);
    sprite.material.opacity = aa.alt > -2 ? THREE.MathUtils.clamp((aa.alt + 2) / 10, 0, 0.95) : 0;
  }

  // Constellation + cluster labels
  for (const c of constellationLabels) {
    const aa = raDecToAltAz(c.raH * 15, c.dec, state.lat, lst);
    c.sprite.position.copy(altAzToVec3(aa.alt, aa.az, SKY_RADIUS * 0.97));
    c.sprite.material.opacity = aa.alt > -5 ? 0.6 * THREE.MathUtils.clamp((aa.alt + 5) / 15, 0, 1) : 0;
  }
  for (const c of clusterLabels) {
    const aa = raDecToAltAz(c.raH * 15, c.dec, state.lat, lst);
    c.sprite.position.copy(altAzToVec3(aa.alt, aa.az, SKY_RADIUS * 0.98));
    c.sprite.material.opacity = aa.alt > -2 ? THREE.MathUtils.clamp((aa.alt + 2) / 10, 0, 0.95) : 0;
  }

  // Milky Way haze
  const hazeArr = hazeGeo.attributes.position.array;
  for (let i = 0; i < hazeStars.length; i++) {
    const [, raH, dec] = hazeStars[i];
    const aa = raDecToAltAz(raH * 15, dec, state.lat, lst);
    const v = altAzToVec3(aa.alt, aa.az, SKY_RADIUS * 0.995);
    hazeArr[i*3] = v.x; hazeArr[i*3+1] = v.y; hazeArr[i*3+2] = v.z;
  }
  hazeGeo.attributes.position.needsUpdate = true;

  // Sun
  const sun = sunPosition(now);
  const sunAA = raDecToAltAz(sun.ra, sun.dec, state.lat, lst);
  placeBody('sun', sunAA, { dist: (sun.dist * 149.6).toFixed(1) + ' M km' });

  // Moon
  const moon = moonPosition(now, sun.eclipticLon);
  const moonAA = raDecToAltAz(moon.ra, moon.dec, state.lat, lst);
  const illum = (1 - Math.cos(deg2rad(moon.elongation))) / 2;
  placeBody('moon', moonAA, { dist: Math.round(moon.dist * 6371) + ' km', illum: (illum*100).toFixed(0) + '%', elong: moon.elongation });

  // Planets
  for (const key of ['mercury','venus','mars','jupiter','saturn','uranus','neptune']) {
    const p = planetPosition(key, now);
    const aa = raDecToAltAz(p.ra, p.dec, state.lat, lst);
    placeBody(key, aa, { dist: p.dist.toFixed(3) + ' AU' });
  }

  refreshObjectList();
  refreshCompassDots();
}

function placeBody(key, altAz, extra) {
  const b = state.bodies.find(x => x.key === key);
  if (!b) return;
  const v = altAzToVec3(altAz.alt, altAz.az, SKY_RADIUS - 20);
  b.sprite.position.copy(v);
  if (b.core) {
    b.core.position.copy(v);
    if (b.core.material.uniforms && b.core.material.uniforms.uLightDir) {
      const sunBody = state.bodies.find(x => x.key === 'sun');
      if (sunBody && key !== 'sun') {
        b.core.material.uniforms.uLightDir.value.copy(sunBody.sprite.position).sub(v).normalize();
      }
    }
  }
  if (b.ring) b.ring.position.copy(v);
  const visible = altAz.alt > -8; // fade in slightly before horizon
  b.sprite.material.opacity = visible ? THREE.MathUtils.clamp((altAz.alt + 8) / 12, 0.15, 1) : 0;
  if (b.core) b.core.visible = altAz.alt > -2;
  if (b.ring) b.ring.visible = altAz.alt > -2;
  b.alt = altAz.alt; b.az = altAz.az; b.extra = extra;
}

// ---------------------------------------------------------------------------
// Device orientation -> camera quaternion
// ---------------------------------------------------------------------------
const _zee = new THREE.Vector3(0, 0, 1);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _euler = new THREE.Euler();
const targetQuat = new THREE.Quaternion();
let haveOrientationFix = false;

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation;
  return 0;
}

function onDeviceOrientation(e) {
  if (e.alpha === null) return;
  haveOrientationFix = true;
  let alpha = e.alpha;
  if (typeof e.webkitCompassHeading === 'number') {
    alpha = 360 - e.webkitCompassHeading; // iOS true heading uses the opposite winding to `alpha`
  }
  state.lastRawAlpha = alpha; // pre-calibration heading, used by the Recenter control
  alpha = norm360(alpha + state.headingOffset);

  _euler.set(deg2rad(e.beta || 0), deg2rad(alpha), deg2rad(-(e.gamma || 0)), 'YXZ');
  targetQuat.setFromEuler(_euler);
  targetQuat.multiply(_q1);
  targetQuat.multiply(_q0.setFromAxisAngle(_zee, -deg2rad(screenAngle())));
}

async function enableSensors() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') throw new Error('denied');
    }
    // Prefer the absolute event (true/Earth-referenced heading) where supported;
    // only fall back to the relative event so we don't process both per tick.
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
    } else {
      window.addEventListener('deviceorientation', onDeviceOrientation, true);
    }
    state.useSensors = true;
    el.pillSensor.classList.remove('off');
    return true;
  } catch (err) {
    state.useSensors = false;
    el.pillSensor.classList.add('off');
    return false;
  }
}

// Fallback: drag to look around
function setupDragControls() {
  const onDown = (x, y) => { state.dragging = true; state.lastX = x; state.lastY = y; };
  const onMove = (x, y) => {
    if (!state.dragging || state.pinching) return;
    state.dragYaw += (x - state.lastX) * 0.25;
    state.dragPitch = THREE.MathUtils.clamp(state.dragPitch - (y - state.lastY) * 0.25, -89, 89);
    state.lastX = x; state.lastY = y;
  };
  const onUp = () => { state.dragging = false; };
  el.canvas.addEventListener('pointerdown', e => onDown(e.clientX, e.clientY));
  window.addEventListener('pointermove', e => onMove(e.clientX, e.clientY));
  window.addEventListener('pointerup', onUp);
}
setupDragControls();

// ---------------------------------------------------------------------------
// Zoom — true optical zoom via camera field-of-view (like swapping to a
// telephoto lens). Every object's real sky position and appearance is
// computed identically regardless of zoom; only the framing changes, so a
// zoomed-in planet or star looks exactly like the real, unmagnified view —
// just larger — never a faked or substituted close-up.
// ---------------------------------------------------------------------------
function setFov(v) {
  state.targetFov = THREE.MathUtils.clamp(v, MIN_FOV, MAX_FOV);
}
function updateZoomIndicator() {
  const zoomX = DEFAULT_FOV / camera.fov;
  if (zoomX > 1.04) {
    el.zoomPill.classList.add('show');
    el.zoomPill.textContent = `⤢ ${zoomX.toFixed(1)}×  ·  tap to reset`;
  } else {
    el.zoomPill.classList.remove('show');
  }
}
function touchDist(t0, t1) {
  return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
}
function setupZoomControls() {
  let pinchStartDist = 0, pinchStartFov = DEFAULT_FOV;

  el.canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      state.pinching = true;
      state.dragging = false;
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartFov = camera.fov;
    }
  }, { passive: true });

  el.canvas.addEventListener('touchmove', (e) => {
    if (state.pinching && e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.max(touchDist(e.touches[0], e.touches[1]), 1);
      setFov(pinchStartFov * (pinchStartDist / dist));
    }
  }, { passive: false });

  el.canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) state.pinching = false;
  }, { passive: true });

  // Desktop: scroll wheel zooms; double-click resets.
  el.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setFov(camera.fov + e.deltaY * 0.04);
  }, { passive: false });
  el.canvas.addEventListener('dblclick', () => setFov(DEFAULT_FOV));

  el.zoomPill.addEventListener('click', () => setFov(DEFAULT_FOV));
}
setupZoomControls();

function updateCameraFromDrag() {
  _euler.set(deg2rad(state.dragPitch), deg2rad(state.dragYaw), 0, 'YXZ');
  targetQuat.setFromEuler(_euler);
}

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------
function startGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(false); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.lat = pos.coords.latitude; state.lon = pos.coords.longitude; state.hasLocation = true;
        navigator.geolocation.watchPosition(
          p => { state.lat = p.coords.latitude; state.lon = p.coords.longitude; },
          () => {}, { enableHighAccuracy: true, maximumAge: 5000 }
        );
        lookUpPlaceName(state.lat, state.lon);
        resolve(true);
      },
      () => resolve(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// Best-effort reverse geocoding for a human-readable place name under the
// coordinates — purely cosmetic, fails silently (offline, blocked, etc.)
async function lookUpPlaceName(lat, lon) {
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (!res.ok) return;
    const data = await res.json();
    const parts = [data.locality, data.principalSubdivision, data.countryName].filter(Boolean);
    if (parts.length) el.locPlace.textContent = parts.join(', ');
  } catch (err) { /* silent — this is a nice-to-have, not core functionality */ }
}

// ---------------------------------------------------------------------------
// UI: crosshair target detection, compass ribbon, object list, detail panel
// ---------------------------------------------------------------------------
function currentLookAltAz() {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const alt = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * (180/Math.PI);
  let az = Math.atan2(dir.x, -dir.z) * (180/Math.PI);
  az = norm360(az);
  return { alt, az };
}

const COMPASS_LABELS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function buildCompassRibbon() {
  el.compassTrack.innerHTML = '';
  for (let deg = -720; deg <= 1080; deg += 22.5) {
    const idx = (Math.round(deg / 22.5) % 16 + 16) % 16;
    const isCard = deg % 90 === 0;
    const t = document.createElement('div');
    t.className = 'tick' + (isCard ? ' card' : '');
    t.dataset.deg = deg;
    t.textContent = isCard ? COMPASS_LABELS[idx] : '·';
    el.compassTrack.appendChild(t);
  }
}
buildCompassRibbon();
function updateCompassRibbon(az) {
  const pxPerDeg = 60 / 22.5;
  const offset = window.innerWidth/2 - (az + 720) * pxPerDeg;
  el.compassTrack.style.transform = `translateX(${offset}px)`;

  const heading = Math.round(norm360(az));
  const idx = Math.round(norm360(az) / 22.5) % 16;
  const dirLabel = COMPASS_LABELS[idx];
  const degText = heading.toString().padStart(3, '0') + '°';
  el.headingBig.innerHTML = `${degText}<span class="dir">${dirLabel}</span>`;
  el.compassDegCenter.textContent = degText;
  el.compassDirCenter.textContent = dirLabel;
}

// ---------------------------------------------------------------------------
// Altitude (up/down) gauge — a fixed vertical scale from zenith to nadir
// ---------------------------------------------------------------------------
function buildAltGauge() {
  const stops = [
    [90, 'ZENITH'], [60, '60°'], [30, '30°'], [0, 'HORIZON'],
    [-30, '-30°'], [-60, '-60°'], [-90, 'NADIR']
  ];
  for (const [deg, label] of stops) {
    const pct = (1 - (deg + 90) / 180) * 100;
    const tick = document.createElement('div');
    tick.className = 'tick' + (deg === 0 ? ' zero' : '');
    tick.style.top = pct + '%';
    el.altTrack.appendChild(tick);
    const tag = document.createElement('div');
    tag.className = 'tag'; tag.style.top = pct + '%'; tag.textContent = label;
    el.altTrack.appendChild(tag);
  }
}
buildAltGauge();
function updateAltGauge(alt) {
  const clamped = THREE.MathUtils.clamp(alt, -90, 90);
  const pct = (1 - (clamped + 90) / 180) * 100;
  el.altMarker.style.top = pct + '%';
  el.altReadout.style.top = pct + '%';
  el.altReadout.textContent = (alt >= 0 ? '▲ ' : '▼ ') + Math.abs(alt).toFixed(0) + '°';
}

// ---------------------------------------------------------------------------
// Rotating compass dial (toggleable) — rotates like a real compass as you turn
// ---------------------------------------------------------------------------
let compassDialOn = false;
el.compassToggle.addEventListener('click', () => {
  compassDialOn = !compassDialOn;
  el.compassDial.classList.toggle('show', compassDialOn);
  el.compassToggle.classList.toggle('off', !compassDialOn);
  el.compassToggle.textContent = compassDialOn ? '◆ COMPASS ON' : '◇ COMPASS OFF';
});
function bodyToCompassLabel(name) {
  return name === 'Sun' ? '☉' : name === 'Moon' ? '☾' : name[0];
}
function refreshCompassDots() {
  el.compassDots.innerHTML = '';
  for (const b of state.bodies) {
    if (b.az === undefined || b.alt === undefined || b.alt < -2) continue;
    const rad = deg2rad(b.az);
    const r = 46; // px from center
    const x = 66 + r * Math.sin(rad), y = 66 - r * Math.cos(rad);
    const dot = document.createElement('div');
    dot.className = 'dot';
    dot.style.left = x + 'px'; dot.style.top = y + 'px';
    dot.style.background = '#' + new THREE.Color(b.color).getHexString();
    dot.style.boxShadow = `0 0 6px #${new THREE.Color(b.color).getHexString()}`;
    dot.title = b.name;
    el.compassDots.appendChild(dot);
  }
}
function updateCompassDial(az) {
  if (!compassDialOn) return;
  el.compassFace.style.transform = `rotate(${-az}deg)`;
}

function refreshObjectList() {
  const rows = [];
  for (const b of state.bodies) {
    if (b.alt === undefined) continue;
    rows.push({ name: b.name, alt: b.alt, az: b.az, key: b.key, dist: b.extra && b.extra.dist ? b.extra.dist : '' });
  }
  rows.sort((a, b) => b.alt - a.alt);
  el.objlist.innerHTML = rows.map(r => `
    <div class="row ${r.alt < 0 ? 'below' : ''}" data-key="${r.key}">
      <span class="n">${r.name}</span><span class="a">${r.alt < 0 ? 'below horizon' : r.dist}</span>
    </div>`).join('');
}
el.objlist.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const b = state.bodies.find(x => x.key === row.dataset.key);
  if (b) openPanelFor(b);
});
el.objlistBtn.addEventListener('click', () => el.objlist.classList.toggle('show'));

function openPanelFor(obj) {
  const isStar = obj.kind === 'star';
  el.pName.textContent = obj.name;
  el.pSub.textContent = isStar ? `Magnitude ${obj.mag.toFixed(2)}` : (obj.key ? obj.key.toUpperCase() : '');
  const rows = [
    ['ALTITUDE', obj.alt.toFixed(1) + '°'],
    ['AZIMUTH', obj.az.toFixed(1) + '°'],
  ];
  if (obj.extra) {
    if (obj.extra.dist) rows.push(['DISTANCE', obj.extra.dist]);
    if (obj.extra.illum) rows.push(['ILLUMINATION', obj.extra.illum]);
  }
  if (obj.lightYears) rows.push(['DISTANCE', obj.lightYears.toLocaleString() + ' light-years']);
  el.pGrid.innerHTML = rows.map(([l, v]) => `<div class="item"><div class="lbl">${l}</div><div class="v">${v}</div></div>`).join('');
  el.panel.classList.add('open');
}
el.closePanel.addEventListener('click', () => el.panel.classList.remove('open'));
el.targetCard.addEventListener('click', () => {
  if (state.pointedObject) openPanelFor(state.pointedObject);
});

function updatePointedTarget() {
  const look = currentLookAltAz();
  state.currentAlt = look.alt; state.currentAz = look.az;
  updateCompassRibbon(look.az);
  updateAltGauge(look.alt);
  updateCompassDial(look.az);

  let best = null, bestSep = 6; // degrees threshold to "lock on"
  for (const b of state.bodies) {
    if (b.alt === undefined || b.alt < -5) continue;
    const sep = angularSeparationDeg(look.alt, look.az, b.alt, b.az);
    if (sep < bestSep) { bestSep = sep; best = { ...b, kind: 'body' }; }
  }
  for (const s of state.starAltAz) {
    if (s.mag > 2.0) continue; // only lock onto brighter stars to avoid clutter
    const sep = angularSeparationDeg(look.alt, look.az, s.alt, s.az);
    if (sep < bestSep) { bestSep = sep; best = s; }
  }

  state.pointedObject = best;
  if (best) {
    el.targetName.textContent = best.name;
    const distStr = best.extra && best.extra.dist ? `  ·  ${best.extra.dist}`
                   : (best.lightYears ? `  ·  ${best.lightYears} ly` : '');
    el.targetMeta.textContent = `ALT ${best.alt.toFixed(1)}°  AZ ${best.az.toFixed(1)}°${distStr}`;
    el.targetCard.classList.add('show');
  } else {
    el.targetCard.classList.remove('show');
  }
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
el.pillCalibrate.addEventListener('click', () => {
  if (state.useSensors && typeof state.lastRawAlpha === 'number') {
    // Treat wherever the phone is pointing right now as due North — the
    // standard fix for the drift/offset every phone compass has.
    state.headingOffset = norm360(-state.lastRawAlpha);
  } else {
    state.dragYaw = 0; state.dragPitch = 0;
  }
  el.pillCalibrate.style.opacity = 0.4;
  setTimeout(() => el.pillCalibrate.style.opacity = 1, 250);
});

el.manGo.addEventListener('click', () => {
  const lat = parseFloat(el.manLat.value), lon = parseFloat(el.manLon.value);
  if (!isNaN(lat) && !isNaN(lon)) {
    state.lat = lat; state.lon = lon; state.hasLocation = true;
    lookUpPlaceName(lat, lon);
    finishBoot();
  }
});

async function finishBoot() {
  el.status.textContent = 'rendering the sky…';
  recomputeSky();
  setInterval(recomputeSky, 4000);
  el.start.classList.add('hide');
}

el.launch.addEventListener('click', async () => {
  el.launch.disabled = true;
  el.status.textContent = 'requesting motion sensors…';

  // Sensor permission must be requested first: iOS Safari only honors the
  // DeviceOrientationEvent prompt while still directly inside a tap gesture.
  const sensorsOk = await enableSensors();
  if (!sensorsOk) el.status.textContent = 'sensors unavailable — drag to look around instead';

  el.status.textContent = 'finding your location…';
  const locOk = await startGeolocation();
  if (!locOk) {
    el.status.textContent = 'location unavailable — enter coordinates manually';
    el.manualLoc.style.display = 'flex';
    el.launch.disabled = false;
    return;
  }
  finishBoot();
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  starMat.uniforms.uTime.value = t;
  if (state.dust) state.dust.rotation.y = t * 0.004;

  // Ease the camera's field of view toward the zoom target — this is what
  // makes pinch/scroll/reset feel like a smooth animated zoom rather than
  // an instant snap, while pinch itself still tracks your fingers live.
  if (Math.abs(camera.fov - state.targetFov) > 0.01) {
    camera.fov += (state.targetFov - camera.fov) * 0.18;
    camera.updateProjectionMatrix();
    updateZoomIndicator();
  }

  if (state.useSensors && haveOrientationFix) {
    camera.quaternion.slerp(targetQuat, 0.35);
  } else {
    updateCameraFromDrag();
    camera.quaternion.slerp(targetQuat, 0.35);
  }

  updatePointedTarget();
  composer.render();
}
animate();

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { publishScreenAnchor } from '/anchor-hook.js';

const $ = (s) => document.querySelector(s);
const intro = $('#intro');
const arUI = $('#ar');
const feed = $('#feed');
const startBtn = $('#startBtn');
const placeBtn = $('#placeBtn');
const moveBtn = $('#moveBtn');
const pulseBtn = $('#pulseBtn');
const exitBtn = $('#exitBtn');
const hint = $('#hint');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const meterFill = $('#meterFill');
const meterValue = $('#meterValue');
const hud = $('#hud');
const message = $('#message');
const messageTitle = $('#messageTitle');
const messageText = $('#messageText');
const retryBtn = $('#retryBtn');

const DEBUG = new URLSearchParams(location.search).has('debug');
if (DEBUG && hud) hud.classList.add('on');

// Application & 3D state
let renderer, scene, camera, reticle, blackHole, simulatorStars;
let xrSession = null;
let xrHitSource = null;
let stream = null;
let mode = 'boot'; // 'xr' | 'fallback' | 'simulator'
let moving = true;
let placed = false;
let reticleReady = false;
let launching = false;
let baseScale = 1.0;
let userMass = 1.0;
let userSpin = 0.85;
let userBrightness = 1.0;
let enableLensingWarp = true;

// Interaction & Physics
let pinchStart = 0;
let pinchScale = 1;
let pointerBoost = 0;
let proximity = 0;
let gravity = 0;
let gravityTarget = 0;
let lastFrame = performance.now();
let nearLatch = false;
let audio = null;

// Simulator Orbit Controls
const simOrbit = {
  isDragging: false,
  previousMousePosition: { x: 0, y: 0 },
  theta: 0.35,
  phi: 1.15,
  radius: 3.2,
  target: new THREE.Vector3(0, 0.78, 0)
};

const gyro = { alpha: 0, beta: 0, gamma: 0, orient: 0, live: false };
const EYE_HEIGHT = 1.55;
const raycaster = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const groundHit = new THREE.Vector3();
const tmpCamPos = new THREE.Vector3();
const tmpCorePos = new THREE.Vector3();
const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

function setStatus(text, ready = false) {
  if (statusText) statusText.textContent = text;
  if (statusDot) statusDot.classList.toggle('ready', ready);
}

function showError(title, text, showSimButton = true) {
  messageTitle.textContent = title;
  messageText.textContent = text;
  message.classList.add('on');

  let simBtn = $('#simFallbackBtn');
  if (!simBtn && showSimButton) {
    simBtn = document.createElement('button');
    simBtn.id = 'simFallbackBtn';
    simBtn.className = 'btn hero';
    simBtn.style.marginTop = '10px';
    simBtn.textContent = 'เข้าสู่โหมดจำลอง 3D เสมือนจริง';
    simBtn.onclick = () => {
      message.classList.remove('on');
      startSimulatorMode();
    };
    message.querySelector('.message-box').appendChild(simBtn);
  } else if (simBtn) {
    simBtn.style.display = showSimButton ? 'block' : 'none';
  }
}

function requestOrientation() {
  if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
    return DeviceOrientationEvent.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted');
}

// -----------------------------------------------------------------------------
// NASA-inspired Audio Engine (Deep cosmic gravity hum + relativistic accretion)
// -----------------------------------------------------------------------------
function initAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.0001;

    // Sub-bass gravitational wave hum (48-72 Hz)
    const low = ctx.createOscillator();
    const lowGain = ctx.createGain();
    low.type = 'sine';
    low.frequency.value = 52;
    lowGain.gain.value = 0.65;
    low.connect(lowGain).connect(master);

    // Deep cosmic resonance
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'triangle';
    sub.frequency.value = 26;
    subGain.gain.value = 0.45;
    sub.connect(subGain).connect(master);

    // Accretion disk plasma turbulence noise
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      output[i] = (b0 + b1 + b2) * 0.11;
    }
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 220;
    noiseFilter.Q.value = 2.8;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.02;

    noiseSource.connect(noiseFilter).connect(noiseGain).connect(master);
    master.connect(ctx.destination);

    low.start();
    sub.start();
    noiseSource.start();
    ctx.resume().catch(() => {});

    return { ctx, master, low, sub, noiseFilter, noiseGain };
  } catch {
    return null;
  }
}

function updateAudio(strength) {
  if (!audio) return;
  const t = audio.ctx.currentTime;
  const vol = placed ? 0.012 + strength * 0.045 : 0.0001;
  audio.master.gain.setTargetAtTime(vol, t, 0.08);
  audio.low.frequency.setTargetAtTime(48 + strength * 26, t, 0.08);
  audio.sub.frequency.setTargetAtTime(24 + strength * 13, t, 0.08);
  audio.noiseFilter.frequency.setTargetAtTime(180 + strength * 420, t, 0.08);
  audio.noiseGain.gain.setTargetAtTime(0.015 + strength * 0.035, t, 0.08);
}

// -----------------------------------------------------------------------------
// Realistic Black Hole Shaders: Relativistic Accretion Disk, Doppler Beaming &
// Gravitational Lensing Arches (Gargantua / General Relativity Simulation)
// -----------------------------------------------------------------------------

// GLSL Noise and helper algorithms shared across shaders
const GLSL_COMMON_ASTRO = `
  const float PI = 3.141592653589793;
  const float TWO_PI = 6.283185307179586;

  // Modulo 289 for Simplex Noise
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy) );
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1  = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
      + i.x + vec3(0.0, i1.x, 1.0 ));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m ;
    m = m*m ;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  // Fractional Brownian Motion for turbulent plasma
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.52;
    mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    for (int i = 0; i < 4; ++i) {
      v += a * snoise(p);
      p = rot * p * 2.08 + vec2(100.0);
      a *= 0.48;
    }
    return v;
  }

  // Astrophysical Blackbody Radiation Color Palette
  vec3 getBlackbodyColor(float tempNorm, float doppler) {
    // Effective temperature shifted by Doppler factor
    float t = clamp(tempNorm * doppler, 0.0, 2.5);

    vec3 coolDust   = vec3(0.38, 0.05, 0.01); // 1,800 K (dark red dust)
    vec3 redOrange  = vec3(1.00, 0.28, 0.04); // 4,000 K (solar orange)
    vec3 goldenWarm = vec3(1.00, 0.68, 0.22); // 7,500 K (bright gold)
    vec3 hotWhite   = vec3(1.00, 0.94, 0.78); // 18,000 K (incandescent white)
    vec3 blueBeamed = vec3(0.72, 0.88, 1.00); // 45,000 K (relativistic blue-shift)

    vec3 col = mix(coolDust, redOrange, smoothstep(0.0, 0.35, t));
    col = mix(col, goldenWarm, smoothstep(0.35, 0.75, t));
    col = mix(col, hotWhite, smoothstep(0.75, 1.35, t));
    col = mix(col, blueBeamed, smoothstep(1.35, 2.2, t));
    return col;
  }
`;

// -----------------------------------------------------------------------------
// 1. Relativistic Raymarched Black Hole (General Relativity Geodesic Raytracer)
// Simulates Schwarzschild & Kerr curved spacetime light deflection, authentic
// Gravitational Lensing arches, Doppler Beaming asymmetry, and Event Horizon shadow.
// -----------------------------------------------------------------------------
function createRelativisticRaymarchedBlackHole() {
  const geo = new THREE.SphereGeometry(2.65, 48, 48);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 },
      uCamLocal: { value: new THREE.Vector3(0, 1, 3.2) },
      uMass: { value: 1.0 },
      uSpin: { value: 0.85 },
      uBrightness: { value: 1.0 },
      uEnableLensing: { value: 1.0 },
      uTilt: { value: 0.38 }
    },
    vertexShader: `
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      void main() {
        vLocalPos = position;
        vec4 worldP = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldP.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldP;
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON_ASTRO}

      uniform float uTime;
      uniform float uGravity;
      uniform vec3 uCamLocal;
      uniform float uMass;
      uniform float uSpin;
      uniform float uBrightness;
      uniform float uEnableLensing;
      uniform float uTilt;

      varying vec3 vLocalPos;
      varying vec3 vWorldPos;

      float intersectSphere(vec3 o, vec3 d, float R) {
        float b = dot(o, d);
        float c = dot(o, o) - R * R;
        float disc = b * b - c;
        if (disc < 0.0) return -1.0;
        return -b - sqrt(disc);
      }

      vec3 getCosmicStarfield(vec3 dir) {
        vec3 col = vec3(0.003, 0.004, 0.009);
        float galacticBand = exp(-abs(dir.y) * 4.4);
        vec3 nebulaCol = mix(vec3(0.09, 0.04, 0.17), vec3(0.22, 0.11, 0.05), dir.x * 0.5 + 0.5);
        col += nebulaCol * galacticBand * 0.9;

        vec3 p = dir * 140.0;
        vec3 fl = floor(p);
        float starRand = fract(sin(dot(fl, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        if (starRand > 0.982) {
          vec3 starFrac = fract(p) - 0.5;
          float starDist = length(starFrac);
          float starBright = smoothstep(0.40, 0.02, starDist) * pow(starRand, 16.0) * 8.5;
          vec3 starTint = mix(vec3(0.78, 0.88, 1.0), vec3(1.0, 0.84, 0.55), fract(starRand * 31.0));
          col += starTint * starBright;
        }
        return col;
      }

      void main() {
        vec3 o = uCamLocal;
        vec3 d = normalize(vLocalPos - uCamLocal);

        float R_BOUND = 2.60 * uMass;
        float tEnter = intersectSphere(o, d, R_BOUND);
        vec3 r = (tEnter > 0.0) ? (o + d * tEnter) : o;
        vec3 v = d;

        float rs = 0.38 * uMass;
        float rh = rs * 0.5 * (1.0 + sqrt(max(0.01, 1.0 - uSpin * uSpin * 0.72)));
        float r_isco = 3.0 * rs * (1.0 - 0.40 * uSpin);
        float r_out = 2.35 * uMass;

        float ct = cos(uTilt);
        float st = sin(uTilt);
        mat3 tiltRot = mat3(
          1.0, 0.0, 0.0,
          0.0,  ct, -st,
          0.0,  st,  ct
        );
        mat3 invTilt = mat3(
          1.0, 0.0, 0.0,
          0.0,  ct,  st,
          0.0, -st,  ct
        );

        vec3 colAcc = vec3(0.0);
        float transmittance = 1.0;
        bool hitHorizon = false;

        for (int i = 0; i < 54; i++) {
          float dist = length(r);

          if (dist <= rh) {
            hitHorizon = true;
            transmittance = 0.0;
            break;
          }

          if (dist > R_BOUND * 1.02) {
            break;
          }

          float dt = clamp((dist - rh * 0.94) * 0.135, 0.018, 0.125);

          if (uEnableLensing > 0.5) {
            vec3 h = cross(r, v);
            float h2 = dot(h, h);
            vec3 a = -1.5 * rs * h2 * r / (dist * dist * dist * dist * dist + 0.00001);
            v = normalize(v + a * dt);
          }

          vec3 nextR = r + v * dt;

          vec3 pDisk = tiltRot * nextR;
          float rD = length(pDisk.xz);

          if (rD >= r_isco && rD <= r_out) {
            float hDisk = 0.015 + 0.025 * (rD - r_isco) / (r_out - r_isco);
            float vertDist = abs(pDisk.y);
            float densityProfile = exp(-0.5 * (vertDist * vertDist) / (hDisk * hDisk));

            if (densityProfile > 0.01) {
              float phi = atan(pDisk.z, pDisk.x);
              float omega = (2.2 + uGravity * 3.5 + uSpin * 2.5) * pow(r_isco / rD, 1.48);
              float rotAngle = phi - uTime * omega;

              float v_orbit = clamp(0.56 * sqrt(0.5 * rs / rD) * (1.0 + 0.22 * uSpin), 0.08, 0.72);
              vec3 orbTangentDisk = vec3(-sin(phi), 0.0, cos(phi));
              vec3 orbTangent = invTilt * orbTangentDisk;

              float cosTheta = dot(orbTangent, -v);
              float beta = v_orbit;
              float gamma = 1.0 / sqrt(max(0.001, 1.0 - beta * beta));
              float doppler = 1.0 / (gamma * (1.0 - beta * cosTheta));
              float dopplerBoost = pow(clamp(doppler, 0.18, 4.0), 3.6);

              float gravRedshift = sqrt(max(0.02, 1.0 - rs / rD));

              vec2 noiseCoord = vec2(cos(rotAngle) * rD * 4.2, sin(rotAngle) * rD * 4.2);
              float plasma = fbm(noiseCoord + vec2(rD * 2.5, uTime * 0.16));
              float streaks = sin(phi * 26.0 - uTime * omega * 3.2 + rD * 32.0) * 0.5 + 0.5;
              float density = densityProfile * (0.62 + plasma * 0.38 + streaks * 0.28);

              float tempNorm = pow((r_out - rD) / (r_out - r_isco), 1.25) * gravRedshift;
              vec3 col = getBlackbodyColor(tempNorm, doppler);

              float photonCaustic = exp(-pow((rD - r_isco) / 0.055, 2.0)) * 2.4;
              col += vec3(1.0, 0.96, 0.88) * photonCaustic * dopplerBoost;

              float dTau = density * (0.90 + uGravity * 0.5) * uBrightness * dt * 16.0;
              float stepTrans = exp(-dTau);
              vec3 emission = col * dopplerBoost * (1.0 - stepTrans);

              colAcc += emission * transmittance;
              transmittance *= stepTrans;

              if (transmittance < 0.015) break;
            }
          }

          r = nextR;
        }

        if (hitHorizon) {
          gl_FragColor = vec4(colAcc, 1.0);
        } else {
          vec3 lensedStarfield = getCosmicStarfield(v);
          vec3 finalCol = colAcc + lensedStarfield * transmittance;
          float finalAlpha = clamp(1.0 - transmittance * 0.90 + length(colAcc) * 0.5, 0.0, 1.0);
          gl_FragColor = vec4(finalCol, finalAlpha);
        }
      }
    `
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  return mesh;
}

// 2. Infalling Matter Streams & Relativistic Accretion Particles
function createInfallingParticles(count = 850) {
  const geo = new THREE.BufferGeometry();
  const angle = new Float32Array(count);
  const radius = new Float32Array(count);
  const height = new Float32Array(count);
  const speed = new Float32Array(count);
  const seed = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    angle[i] = Math.random() * Math.PI * 2;
    radius[i] = 0.45 + Math.pow(Math.random(), 0.65) * 1.8;
    height[i] = (Math.random() - 0.5) * (0.04 + radius[i] * 0.08);
    speed[i] = 0.4 + Math.random() * 1.6;
    seed[i] = Math.random();
  }

  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
  geo.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) }
    },
    vertexShader: `
      attribute float aAngle;
      attribute float aRadius;
      attribute float aHeight;
      attribute float aSpeed;
      attribute float aSeed;
      uniform float uTime;
      uniform float uGravity;
      uniform float uPixelRatio;
      varying float vHeat;
      varying float vAlpha;

      void main(){
        float t = uTime * aSpeed * (1.2 + uGravity * 3.8);
        float phase = fract(aSeed + uTime * (0.03 + aSpeed * 0.015) * max(uGravity, 0.25));
        float plunge = pow(phase, 8.0) * (0.5 + uGravity * 0.5);
        float r = mix(aRadius, 0.36, plunge);
        float a = aAngle + t + (1.0 / max(0.2, r)) * 1.8;
        float y = aHeight * (1.0 - plunge) + sin(t * 2.0 + aSeed * 12.0) * 0.015;

        vec3 p = vec3(cos(a) * r, y, sin(a) * r);
        float tilt = 0.38;
        float cy = cos(tilt), sy = sin(tilt);
        p = vec3(p.x, p.y * cy - p.z * sy, p.y * sy + p.z * cy);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;

        float size = mix(2.5, 6.5, uGravity) * (1.0 + (1.0 - r / aRadius) * 1.8);
        gl_PointSize = size * uPixelRatio * (1.4 / max(0.3, -mv.z));

        vHeat = clamp(1.0 - (r - 0.36) / 1.6, 0.0, 1.0);
        vAlpha = (0.4 + aSeed * 0.6) * smoothstep(0.36, 0.42, r);
      }
    `,
    fragmentShader: `
      precision mediump float;
      varying float vHeat;
      varying float vAlpha;

      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float d = length(q);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.05, d) * vAlpha;

        vec3 outer = vec3(0.95, 0.32, 0.08);
        vec3 inner = vec3(1.00, 0.95, 0.85);
        vec3 col = mix(outer, inner, vHeat);
        gl_FragColor = vec4(col * 1.4, a);
      }
    `
  });

  const points = new THREE.Points(geo, mat);
  points.renderOrder = 3;
  return points;
}

// Assemble Complete Realistic Black Hole System
function buildRealisticBlackHole() {
  const root = new THREE.Group();
  root.visible = false;

  const core = new THREE.Object3D();
  core.position.y = 0.78;
  root.add(core);

  const rayVolume = createRelativisticRaymarchedBlackHole();
  rayVolume.position.y = 0.78;
  root.add(rayVolume);

  const particles = createInfallingParticles();
  particles.position.y = 0.78;
  root.add(particles);

  root.userData = {
    core,
    rayVolume,
    particles
  };
  return root;
}

// Placement Reticle with Quantum Targeting Graphics
function makeReticle() {
  const group = new THREE.Group();

  const outer = new THREE.Mesh(
    new THREE.RingGeometry(0.18, 0.22, 64),
    new THREE.MeshBasicMaterial({ color: 0x8ddcff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  outer.rotation.x = -Math.PI / 2;
  group.add(outer);

  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.035, 0.05, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd28f, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
  );
  inner.rotation.x = -Math.PI / 2;
  group.add(inner);

  const ticks = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const tick = new THREE.Mesh(
      new THREE.PlaneGeometry(0.015, 0.08),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
    );
    const angle = (i * Math.PI) / 2;
    tick.position.set(Math.cos(angle) * 0.28, 0.002, Math.sin(angle) * 0.28);
    tick.rotation.x = -Math.PI / 2;
    tick.rotation.z = -angle;
    ticks.add(tick);
  }
  group.add(ticks);

  group.visible = false;
  return group;
}

// Deep Space Starfield & Cosmic Nebula (for 3D Simulator mode & depth)
function buildCosmicSpace() {
  const group = new THREE.Group();

  const starGeo = new THREE.BufferGeometry();
  const count = 1600;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const r = 25 + Math.random() * 50;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Warm white, blue-white, and amber stars
    const type = Math.random();
    if (type > 0.8) {
      colors[i * 3] = 0.75; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 1.0;
    } else if (type > 0.6) {
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.82; colors[i * 3 + 2] = 0.55;
    } else {
      colors[i * 3] = 0.95; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.95;
    }
  }

  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const starMat = new THREE.PointsMaterial({
    size: 0.18,
    vertexColors: true,
    transparent: true,
    opacity: 0.85
  });

  const stars = new THREE.Points(starGeo, starMat);
  group.add(stars);

  // Virtual floor grid for AR simulation
  const grid = new THREE.GridHelper(12, 24, 0x3d5485, 0x182440);
  grid.position.y = 0;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  group.add(grid);

  group.visible = false;
  return group;
}

// -----------------------------------------------------------------------------
// Scene & Renderer Initialization
// -----------------------------------------------------------------------------
function buildScene() {
  if (scene) return;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.01, 120);
  camera.position.set(0, EYE_HEIGHT, 0);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.className = 'gl';
  document.body.appendChild(renderer.domElement);

  simulatorStars = buildCosmicSpace();
  scene.add(simulatorStars);

  reticle = makeReticle();
  scene.add(reticle);

  blackHole = buildRealisticBlackHole();
  scene.add(blackHole);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (blackHole?.userData?.particles?.material?.uniforms?.uPixelRatio) {
      blackHole.userData.particles.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
    }
  });

  setupSimulatorControls();
}

function updateReady(v) {
  if (v === reticleReady) return;
  reticleReady = v;
  if (placeBtn) {
    placeBtn.disabled = !v;
    placeBtn.classList.toggle('ready', v);
  }
  if (arUI) arUI.classList.toggle('ready-to-place', v && moving);
  setStatus(v ? 'จับพื้นได้แล้ว' : 'กำลังจับพื้น', v);
  if (moving && hint) {
    hint.textContent = v ? 'พร้อมแล้ว · แตะ “วางหลุมดำ”' : 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ';
  }
}

function placeBlackHole() {
  if (!moving) return;
  if (mode === 'simulator' || reticle.visible) {
    if (mode === 'simulator') {
      blackHole.position.set(0, 0, -1.8);
    } else {
      blackHole.position.copy(reticle.position);
    }
    blackHole.scale.setScalar(baseScale * userMass);
    blackHole.visible = true;
    reticle.visible = false;
    moving = false;
    placed = true;
    if (placeBtn) placeBtn.hidden = true;
    if (moveBtn) moveBtn.hidden = false;
    if (pulseBtn) pulseBtn.hidden = false;
    if (arUI) arUI.classList.remove('ready-to-place');

    if (hint) {
      hint.textContent = mode === 'xr'
        ? 'เดินเข้าใกล้เพื่อเพิ่มแรงโน้มถ่วง · ใช้สองนิ้วย่อ/ขยาย'
        : mode === 'simulator'
          ? 'ลากหน้าจอเพื่อหมุนรอบหลุมดำ · ซูมเข้าใกล้เพื่อเพิ่มแรงโน้มถ่วง'
          : 'แตะค้างบนจอหรือกด “เร่งแรงดูด” · เดินเข้าใกล้หลุมดำ';
    }
    setStatus('หลุมดำทำงาน', true);
  }
}

function moveBlackHole() {
  moving = true;
  placed = false;
  blackHole.visible = false;
  if (placeBtn) placeBtn.hidden = false;
  if (moveBtn) moveBtn.hidden = true;
  if (pulseBtn) pulseBtn.hidden = true;
  pointerBoost = 0;
  updateReady(false);
  if (hint) hint.textContent = 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ';
}

function pulseGravity() {
  if (!placed) return;
  pointerBoost = 1.0;
  navigator.vibrate?.([24, 36, 42]);
}

function orientCamera() {
  if (!gyro.live) return;
  euler.set(gyro.beta, gyro.alpha, -gyro.gamma, 'YXZ');
  camera.quaternion.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -gyro.orient));
}

function updateGravity(activeCamera, dt) {
  if (!placed || !blackHole.visible) {
    gravityTarget = 0;
    gravity += (gravityTarget - gravity) * Math.min(1, dt * 7);
    updateAudio(gravity);
    return;
  }

  activeCamera.getWorldPosition(tmpCamPos);
  blackHole.userData.core.getWorldPosition(tmpCorePos);
  const distance = tmpCamPos.distanceTo(tmpCorePos);

  if (mode === 'xr' || mode === 'simulator') {
    proximity = THREE.MathUtils.clamp(1 - (distance - 0.75) / 2.8, 0, 1);
    proximity = proximity * proximity * (3 - 2 * proximity);
  } else {
    proximity = THREE.MathUtils.clamp(1 - (distance - 0.75) / 2.8, 0, 1);
  }

  pointerBoost *= Math.max(0, 1 - dt * 0.8);
  gravityTarget = Math.max(0.12, proximity, pointerBoost);
  gravity += (gravityTarget - gravity) * Math.min(1, dt * 4.5);

  const pct = Math.round(gravity * 100);
  if (meterFill) meterFill.style.transform = `scaleX(${Math.max(0.04, gravity)})`;
  if (meterValue) meterValue.textContent = `${pct}%`;

  if (gravity > 0.78 && !nearLatch) {
    nearLatch = true;
    navigator.vibrate?.([18, 22, 26]);
  }
  if (gravity < 0.55) nearLatch = false;

  updateAudio(gravity);
}

function animateRealisticBlackHole(t, activeCamera) {
  if (!blackHole || !blackHole.visible) return;
  const { core, rayVolume, particles } = blackHole.userData;

  // Transform camera position into raymarched volume local coordinates
  activeCamera.getWorldPosition(tmpCamPos);
  const localCam = rayVolume ? rayVolume.worldToLocal(tmpCamPos.clone()) : blackHole.worldToLocal(tmpCamPos.clone());

  // Update Relativistic Raymarched Shader
  if (rayVolume?.material?.uniforms) {
    rayVolume.material.uniforms.uTime.value = t;
    rayVolume.material.uniforms.uGravity.value = gravity;
    rayVolume.material.uniforms.uCamLocal.value.copy(localCam);
    rayVolume.material.uniforms.uMass.value = userMass;
    rayVolume.material.uniforms.uSpin.value = userSpin;
    rayVolume.material.uniforms.uBrightness.value = userBrightness;
    rayVolume.material.uniforms.uEnableLensing.value = enableLensingWarp ? 1.0 : 0.0;
  }

  // Update infalling matter particles
  if (particles?.material?.uniforms) {
    particles.material.uniforms.uTime.value = t;
    particles.material.uniforms.uGravity.value = gravity;
  }
}

function renderCommon(activeCamera, now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  updateGravity(activeCamera, dt);
  animateRealisticBlackHole(now / 1000, activeCamera);
  publishScreenAnchor(blackHole, activeCamera);
  updateHud(activeCamera);
}

function renderFallback(now) {
  orientCamera();
  camera.updateMatrixWorld(true);

  if (moving) {
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const ok = raycaster.ray.intersectPlane(ground, groundHit) && groundHit.distanceTo(camera.position) < 7;
    reticle.visible = !!ok;
    if (ok) reticle.position.copy(groundHit);
    updateReady(!!ok);
  }

  renderCommon(camera, now);
  renderer.render(scene, camera);
}

function renderXR(now, frame) {
  if (frame && moving && xrHitSource) {
    const ref = renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(xrHitSource);
    if (hits.length) {
      const pose = hits[0].getPose(ref);
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      reticle.position.setFromMatrixPosition(m);
      reticle.visible = true;
      updateReady(true);
    } else {
      reticle.visible = false;
      updateReady(false);
    }
  }

  const activeCamera = renderer.xr.getCamera(camera);
  renderCommon(activeCamera, now);
  renderer.render(scene, camera);
}

function renderSimulator(now) {
  updateSimulatorCamera();
  renderCommon(camera, now);
  renderer.render(scene, camera);
}

// -----------------------------------------------------------------------------
// Interactive 3D Simulator (Orbit, Zoom & Inspect)
// -----------------------------------------------------------------------------
function setupSimulatorControls() {
  const onPointerDown = (e) => {
    if (mode !== 'simulator' || e.target.closest('button, .physics-panel, .info-drawer')) return;
    simOrbit.isDragging = true;
    simOrbit.previousMousePosition = { x: e.clientX || e.touches?.[0]?.clientX || 0, y: e.clientY || e.touches?.[0]?.clientY || 0 };
  };

  const onPointerMove = (e) => {
    if (!simOrbit.isDragging || mode !== 'simulator') return;
    const clientX = e.clientX || e.touches?.[0]?.clientX || 0;
    const clientY = e.clientY || e.touches?.[0]?.clientY || 0;
    const deltaX = clientX - simOrbit.previousMousePosition.x;
    const deltaY = clientY - simOrbit.previousMousePosition.y;

    simOrbit.theta -= deltaX * 0.007;
    simOrbit.phi = THREE.MathUtils.clamp(simOrbit.phi - deltaY * 0.007, 0.15, Math.PI - 0.15);

    simOrbit.previousMousePosition = { x: clientX, y: clientY };
  };

  const onPointerUp = () => { simOrbit.isDragging = false; };

  const onWheel = (e) => {
    if (mode !== 'simulator') return;
    simOrbit.radius = THREE.MathUtils.clamp(simOrbit.radius + e.deltaY * 0.003, 1.2, 7.5);
  };

  window.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('touchstart', onPointerDown, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('touchend', onPointerUp, { passive: true });
  window.addEventListener('wheel', onWheel, { passive: true });
}

function updateSimulatorCamera() {
  const x = simOrbit.target.x + simOrbit.radius * Math.sin(simOrbit.phi) * Math.sin(simOrbit.theta);
  const y = simOrbit.target.y + simOrbit.radius * Math.cos(simOrbit.phi);
  const z = simOrbit.target.z + simOrbit.radius * Math.sin(simOrbit.phi) * Math.cos(simOrbit.theta);
  camera.position.set(x, y, z);
  camera.lookAt(simOrbit.target);
}

function startSimulatorMode() {
  mode = 'simulator';
  buildScene();
  intro.style.display = 'none';
  arUI.classList.add('on');
  if (feed) feed.style.display = 'none';
  if (simulatorStars) simulatorStars.visible = true;

  renderer.setAnimationLoop(renderSimulator);
  setStatus('โหมดจำลอง 3D เสมือนจริง', true);
  if (hint) hint.textContent = 'แตะ “วางหลุมดำ” เพื่อเริ่มสำรวจในอวกาศจำลอง';
  updateReady(true);
}

// -----------------------------------------------------------------------------
// Launch Flow & Mode Detectors
// -----------------------------------------------------------------------------
function requestXRSession() {
  if (!navigator.xr) return Promise.resolve(null);
  try {
    return navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: arUI }
    }).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

async function startXR(session) {
  mode = 'xr';
  renderer.xr.enabled = true;
  xrSession = session;
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(xrSession);
  const viewer = await xrSession.requestReferenceSpace('viewer');
  xrHitSource = await xrSession.requestHitTestSource({ space: viewer });
  xrSession.addEventListener('select', () => {
    if (moving) placeBlackHole();
    else pulseGravity();
  });
  xrSession.addEventListener('end', () => location.reload());
  renderer.setAnimationLoop(renderXR);
  setStatus('WebXR พร้อมใช้งาน', false);
  if (hint) hint.textContent = 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ';
}

async function startFallback(orientationGranted) {
  mode = 'fallback';
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  feed.srcObject = stream;
  feed.style.display = 'block';
  await feed.play().catch(() => {});

  gyro.live = orientationGranted === 'granted';
  if (gyro.live) {
    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha == null) return;
      gyro.alpha = THREE.MathUtils.degToRad(e.alpha);
      gyro.beta = THREE.MathUtils.degToRad(e.beta);
      gyro.gamma = THREE.MathUtils.degToRad(e.gamma);
      gyro.orient = THREE.MathUtils.degToRad(screen.orientation?.angle || window.orientation || 0);
    }, true);
  } else {
    camera.rotation.set(-0.48, 0, 0);
  }

  renderer.setAnimationLoop(renderFallback);
  setStatus(gyro.live ? 'กล้อง + ไจโรพร้อม' : 'กล้องพร้อม', false);
  if (hint) {
    hint.textContent = gyro.live
      ? 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ'
      : 'เล็งกล้องลงพื้น · เครื่องนี้ไม่อนุญาตเซ็นเซอร์หมุน';
  }
}

async function launch() {
  if (launching) return;
  launching = true;
  audio = initAudio();
  const orientationPromise = requestOrientation();
  const xrSessionPromise = requestXRSession();
  startBtn.disabled = true;
  startBtn.textContent = 'กำลังเปิดกล้อง…';

  try {
    buildScene();
    intro.style.display = 'none';
    arUI.classList.add('on');
    setStatus('กำลังตรวจ AR', false);

    const session = await xrSessionPromise;
    if (session) {
      await startXR(session);
    } else if (navigator.mediaDevices?.getUserMedia) {
      const orientation = await orientationPromise;
      await startFallback(orientation);
    } else {
      startSimulatorMode();
    }
  } catch (e) {
    console.warn('[AR Black Hole] Camera/XR fallback to Simulator:', e);
    // Graceful fallback to 3D Simulator so user is never blocked
    startSimulatorMode();
  }
}

function updateHud(activeCamera) {
  if (!DEBUG || !blackHole || !hud) return;
  activeCamera.getWorldPosition(tmpCamPos);
  blackHole.userData.core.getWorldPosition(tmpCorePos);
  hud.textContent = [
    `mode: ${mode}`,
    `placed: ${placed} moving: ${moving}`,
    `gravity: ${gravity.toFixed(3)} target: ${gravityTarget.toFixed(3)}`,
    `mass: ${userMass.toFixed(2)} spin: ${userSpin.toFixed(2)}`,
    `cam: [${tmpCamPos.x.toFixed(2)}, ${tmpCamPos.y.toFixed(2)}, ${tmpCamPos.z.toFixed(2)}]`
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Interactive Physics & Astrophysics UI Controls
// -----------------------------------------------------------------------------
function setupInteractiveUI() {
  const simIntroBtn = $('#simIntroBtn');
  if (simIntroBtn) {
    simIntroBtn.addEventListener('click', () => {
      audio = initAudio();
      startSimulatorMode();
    });
  }

  // Physics Drawer & Inspector
  const physicsBtn = $('#physicsBtn');
  const physicsPanel = $('#physicsPanel');
  const infoBtn = $('#infoBtn');
  const infoDrawer = $('#infoDrawer');
  const closeInfoBtn = $('#closeInfoBtn');

  // Video Modal
  const videoBtn = $('#videoBtn');
  const introVideoBtn = $('#introVideoBtn');
  const videoModal = $('#videoModal');
  const closeVideoBtn = $('#closeVideoBtn');
  const youtubeIframe = $('#youtubeIframe');
  const NASA_VIDEO_ID = 'chhcwk4-esM';

  if (physicsBtn && physicsPanel) {
    physicsBtn.addEventListener('click', () => {
      physicsPanel.classList.toggle('active');
      if (infoDrawer) infoDrawer.classList.remove('active');
      if (videoModal) videoModal.classList.remove('active');
    });
  }

  if (infoBtn && infoDrawer) {
    infoBtn.addEventListener('click', () => {
      infoDrawer.classList.toggle('active');
      if (physicsPanel) physicsPanel.classList.remove('active');
      if (videoModal) videoModal.classList.remove('active');
    });
  }

  if (closeInfoBtn && infoDrawer) {
    closeInfoBtn.addEventListener('click', () => {
      infoDrawer.classList.remove('active');
    });
  }

  const openVideoModal = () => {
    if (!videoModal) return;
    videoModal.classList.add('active');
    if (physicsPanel) physicsPanel.classList.remove('active');
    if (infoDrawer) infoDrawer.classList.remove('active');
    if (youtubeIframe && !youtubeIframe.src) {
      youtubeIframe.src = `https://www.youtube.com/embed/${NASA_VIDEO_ID}?autoplay=1&rel=0`;
    }
  };

  if (videoBtn) videoBtn.addEventListener('click', openVideoModal);
  if (introVideoBtn) introVideoBtn.addEventListener('click', openVideoModal);

  if (closeVideoBtn && videoModal) {
    closeVideoBtn.addEventListener('click', () => {
      videoModal.classList.remove('active');
      if (youtubeIframe) youtubeIframe.src = '';
    });
  }

  // Sliders
  const massSlider = $('#massSlider');
  const spinSlider = $('#spinSlider');
  const brightnessSlider = $('#brightnessSlider');
  const lensingToggle = $('#lensingToggle');

  if (massSlider) {
    massSlider.addEventListener('input', (e) => {
      userMass = parseFloat(e.target.value);
      if (blackHole) blackHole.scale.setScalar(baseScale * userMass);
    });
  }

  if (spinSlider) {
    spinSlider.addEventListener('input', (e) => {
      userSpin = parseFloat(e.target.value);
    });
  }

  if (brightnessSlider) {
    brightnessSlider.addEventListener('input', (e) => {
      userBrightness = parseFloat(e.target.value);
    });
  }

  if (lensingToggle) {
    lensingToggle.addEventListener('change', (e) => {
      enableLensingWarp = e.target.checked;
    });
  }
}

// Event Listeners
startBtn.addEventListener('click', launch);
if (placeBtn) placeBtn.addEventListener('click', placeBlackHole);
if (moveBtn) moveBtn.addEventListener('click', moveBlackHole);
if (pulseBtn) pulseBtn.addEventListener('click', pulseGravity);
if (exitBtn) exitBtn.addEventListener('click', () => location.reload());
if (retryBtn) retryBtn.addEventListener('click', () => location.reload());

window.addEventListener('pointerdown', (e) => {
  if (!placed || e.target.closest('button, .interactive-ui')) return;
  pointerBoost = Math.max(pointerBoost, 0.65);
});
window.addEventListener('pointermove', (e) => {
  if (!placed || !(e.buttons & 1) || e.target.closest('button, .interactive-ui')) return;
  pointerBoost = 1.0;
});
window.addEventListener('pointerup', () => {
  if (mode !== 'xr') pointerBoost = Math.max(pointerBoost, 0.45);
});

// Pinch-to-scale
window.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && placed) {
    pinchStart = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    pinchScale = baseScale;
  }
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && placed && pinchStart) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    baseScale = THREE.MathUtils.clamp((pinchScale * d) / pinchStart, 0.45, 2.8);
    blackHole.scale.setScalar(baseScale * userMass);
  }
}, { passive: true });

window.addEventListener('touchend', () => { pinchStart = 0; }, { passive: true });

window.addEventListener('beforeunload', () => {
  stream?.getTracks().forEach((t) => t.stop());
  if (audio?.ctx && audio.ctx.state !== 'closed') audio.ctx.close().catch(() => {});
});

// Initialize UI binders on page load
setupInteractiveUI();

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

// 1. Primary Physical 3D Accretion Disk
function createAccretionDisk() {
  const geo = new THREE.RingGeometry(0.40, 1.88, 256, 32);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 },
      uCamLocal: { value: new THREE.Vector3(0, 1, 2) },
      uSpin: { value: 0.85 },
      uBrightness: { value: 1.0 }
    },
    vertexShader: `
      ${GLSL_COMMON_ASTRO}
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vViewDir;
      uniform vec3 uCamLocal;

      void main(){
        vLocalPos = position;
        vec4 worldP = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldP.xyz;
        vViewDir = normalize(uCamLocal - position);
        gl_Position = projectionMatrix * viewMatrix * worldP;
      }
    `,
    fragmentShader: `
      ${GLSL_COMMON_ASTRO}
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vViewDir;
      uniform float uTime;
      uniform float uGravity;
      uniform float uSpin;
      uniform float uBrightness;

      void main(){
        float r = length(vLocalPos.xy);
        if (r < 0.40 || r > 1.88) discard;

        float phi = atan(vLocalPos.y, vLocalPos.x);

        // Keplerian differential rotation: inner orbits much faster than outer
        float omega = (1.8 + uGravity * 3.5 + uSpin * 2.2) * pow(0.40 / r, 1.45);
        float rotAngle = phi - uTime * omega;

        // Swirling plasma turbulence & spiral density waves
        vec2 noiseCoord = vec2(cos(rotAngle) * r * 3.8, sin(rotAngle) * r * 3.8);
        float plasma = fbm(noiseCoord + vec2(r * 2.5, uTime * 0.2));
        float streaks = sin(phi * 18.0 - uTime * omega * 4.0 + r * 32.0) * 0.5 + 0.5;
        float density = clamp(0.55 + plasma * 0.45 + streaks * 0.25, 0.0, 1.5);

        // Relativistic Keplerian Orbital Velocity
        float v_orbit = clamp(0.54 * sqrt(0.42 / r), 0.08, 0.65);
        vec3 orbitalTangent = vec3(-sin(phi), cos(phi), 0.0);
        float cosTheta = dot(orbitalTangent, normalize(vViewDir));

        // Relativistic Doppler Factor: delta = sqrt(1 - beta^2) / (1 - beta * cos(theta))
        float beta = v_orbit;
        float gamma = 1.0 / sqrt(max(0.001, 1.0 - beta * beta));
        float doppler = 1.0 / (gamma * (1.0 - beta * cosTheta));
        float dopplerBoost = pow(clamp(doppler, 0.25, 3.2), 3.4);

        // Radial Temperature Gradient (ISCO is blisteringly hot, outer rim is cooler red)
        float tempNorm = pow((1.88 - r) / (1.88 - 0.40), 1.25);
        vec3 color = getBlackbodyColor(tempNorm, doppler);

        // Radial boundary falloff
        float innerFade = smoothstep(0.40, 0.46, r);
        float outerFade = smoothstep(1.88, 1.55, r);
        float alpha = innerFade * outerFade * density * (0.82 + uGravity * 0.42) * uBrightness;

        gl_FragColor = vec4(color * dopplerBoost * alpha * 1.55, alpha * 0.95);
      }
    `
  });

  const mesh = new THREE.Mesh(geo, mat);
  // Realistic astrophysical tilt: ~22 degrees inclination
  mesh.rotation.x = -Math.PI / 2 + 0.38;
  mesh.rotation.z = 0.12;
  mesh.renderOrder = 3;
  return mesh;
}

// 2. Gravitational Lensing Arches (Gargantua Upper & Lower Lensed Arches)
// In General Relativity, light from the rear accretion disk bends over and under the horizon.
function createLensingArches() {
  const geo = new THREE.SphereGeometry(0.58, 144, 72);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 },
      uCamLocal: { value: new THREE.Vector3(0, 1, 2) },
      uSpin: { value: 0.85 },
      uBrightness: { value: 1.0 }
    },
    vertexShader: `
      ${GLSL_COMMON_ASTRO}
      varying vec3 vLocalPos;
      varying vec3 vViewDir;
      uniform vec3 uCamLocal;

      void main(){
        vLocalPos = position;
        vViewDir = normalize(uCamLocal - position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      ${GLSL_COMMON_ASTRO}
      varying vec3 vLocalPos;
      varying vec3 vViewDir;
      uniform float uTime;
      uniform float uGravity;
      uniform float uSpin;
      uniform float uBrightness;

      void main(){
        // Ray deflection geometry mapped to the rear accretion disk plane
        vec3 p = normalize(vLocalPos);
        float diskAngle = p.y;
        float r = length(vLocalPos.xz);

        // Arches appear primarily above and below the shadow
        float upperArc = smoothstep(0.04, 0.35, p.y) * smoothstep(0.95, 0.45, p.y);
        float lowerArc = smoothstep(-0.04, -0.32, p.y) * smoothstep(-0.95, -0.42, p.y);
        float arcWeight = upperArc + lowerArc * 0.65;
        if (arcWeight < 0.01) discard;

        float phi = atan(p.z, p.x);
        float simR = 0.48 + abs(p.y) * 1.15;
        float omega = (1.8 + uGravity * 3.5 + uSpin * 2.2) * pow(0.40 / simR, 1.45);
        float rotAngle = phi - uTime * omega;

        // Plasma noise mapped onto lensed geodesic
        vec2 noiseCoord = vec2(cos(rotAngle) * simR * 4.2, sin(rotAngle) * simR * 4.2);
        float plasma = fbm(noiseCoord + vec2(simR * 2.8, uTime * 0.2));
        float streaks = sin(phi * 22.0 - uTime * omega * 4.0 + simR * 36.0) * 0.5 + 0.5;

        // Relativistic Doppler on the lensed rays
        float v_orbit = clamp(0.52 * sqrt(0.42 / simR), 0.08, 0.62);
        vec3 orbitalTangent = vec3(-sin(phi), 0.0, cos(phi));
        float cosTheta = dot(orbitalTangent, normalize(vViewDir));
        float beta = v_orbit;
        float gamma = 1.0 / sqrt(max(0.001, 1.0 - beta * beta));
        float doppler = 1.0 / (gamma * (1.0 - beta * cosTheta));
        float dopplerBoost = pow(clamp(doppler, 0.3, 3.0), 3.2);

        float tempNorm = pow((1.88 - simR) / (1.88 - 0.40), 1.3);
        vec3 color = getBlackbodyColor(tempNorm, doppler);

        float edgeFade = smoothstep(0.58, 0.54, length(vLocalPos));
        float alpha = arcWeight * (0.65 + plasma * 0.35 + streaks * 0.20) * (0.85 + uGravity * 0.5) * uBrightness;

        gl_FragColor = vec4(color * dopplerBoost * alpha * 1.6, alpha * 0.85);
      }
    `
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = 0.38;
  mesh.rotation.z = 0.12;
  mesh.renderOrder = 2;
  return mesh;
}

// 3. Event Horizon Sphere & Photon Sphere Caustic Ring
function createEventHorizonAndPhotonRing() {
  const group = new THREE.Group();

  // True 3D Event Horizon (Black Hole Shadow) - Perfectly Opaque Absorber
  const horizonGeo = new THREE.SphereGeometry(0.35, 64, 48);
  const horizonMat = new THREE.ShaderMaterial({
    depthWrite: true,
    uniforms: {
      uGravity: { value: 0 },
      uTime: { value: 0 }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main(){
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      uniform float uGravity;
      uniform float uTime;

      void main(){
        // Absolute black event horizon with quantum rim extinction
        float edge = dot(vNormal, vViewDir);
        float horizonGlow = pow(1.0 - max(0.0, edge), 9.0) * (0.15 + uGravity * 0.12);
        vec3 quantumRim = vec3(0.85, 0.65, 0.40) * horizonGlow;
        gl_FragColor = vec4(quantumRim, 1.0);
      }
    `
  });
  const horizonMesh = new THREE.Mesh(horizonGeo, horizonMat);
  horizonMesh.renderOrder = 4;
  group.add(horizonMesh);

  // Razor-sharp Photon Sphere Caustic Ring (r = 1.5 * Rs = 0.525)
  const ringGeo = new THREE.TorusGeometry(0.525, 0.016, 24, 256);
  const ringMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 }
    },
    vertexShader: `
      varying vec3 vNormal;
      void main(){
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      uniform float uTime;
      uniform float uGravity;

      void main(){
        // Intense photon sphere caustic peak with sub-ring oscillations
        float pulse = 0.88 + 0.12 * sin(uTime * 3.5);
        vec3 corePhoton = vec3(1.00, 0.96, 0.88) * (1.8 + uGravity * 0.9) * pulse;
        vec3 outerHalo  = vec3(1.00, 0.55, 0.18) * (0.8 + uGravity * 0.6);
        vec3 col = mix(corePhoton, outerHalo, 0.35);
        gl_FragColor = vec4(col, 0.95);
      }
    `
  });
  const photonRing = new THREE.Mesh(ringGeo, ringMat);
  photonRing.renderOrder = 5;
  group.add(photonRing);

  return { group, horizonMesh, photonRing };
}

// 4. Infalling Matter Streams & Relativistic Accretion Particles
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
        // Accelerate inward as particles approach ISCO & the Event Horizon
        float t = uTime * aSpeed * (1.2 + uGravity * 3.8);
        float phase = fract(aSeed + uTime * (0.03 + aSpeed * 0.015) * max(uGravity, 0.25));
        float plunge = pow(phase, 8.0) * (0.5 + uGravity * 0.5);
        float r = mix(aRadius, 0.36, plunge);
        float a = aAngle + t + (1.0 / max(0.2, r)) * 1.8;
        float y = aHeight * (1.0 - plunge) + sin(t * 2.0 + aSeed * 12.0) * 0.015;

        // Tilted particle orbit alignment
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

        vec3 outer = vec3(0.95, 0.32, 0.08); // Fiery orange
        vec3 inner = vec3(1.00, 0.95, 0.85); // Incandescent white-hot
        vec3 col = mix(outer, inner, vHeat);
        gl_FragColor = vec4(col * 1.4, a);
      }
    `
  });

  const points = new THREE.Points(geo, mat);
  points.renderOrder = 4;
  return points;
}

// 5. Spacetime Gravitational Lensing Distortion Shell (Warping background)
function createLensingDistortionShell() {
  const geo = new THREE.SphereGeometry(1.45, 64, 32);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uGravity: { value: 0 },
      uTime: { value: 0 }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vLocalPos;
      void main(){
        vNormal = normalize(normalMatrix * normal);
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vLocalPos;
      uniform float uGravity;
      uniform float uTime;

      void main(){
        float r = length(vLocalPos);
        // Einstein deflection angle curve: alpha = 4GM / c^2 b
        float rNorm = clamp(r / 1.45, 0.0, 1.0);
        float einsteinDeflection = pow(1.0 - rNorm, 3.2);

        vec3 warpColor = vec3(0.55, 0.75, 1.0) * einsteinDeflection * (0.28 + uGravity * 0.35);
        gl_FragColor = vec4(warpColor, einsteinDeflection * 0.4);
      }
    `
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return mesh;
}

// Assemble Complete Realistic Black Hole System
function buildRealisticBlackHole() {
  const root = new THREE.Group();
  root.visible = false;

  const { group: horizonGroup, horizonMesh, photonRing } = createEventHorizonAndPhotonRing();
  horizonGroup.position.y = 0.78;
  root.add(horizonGroup);

  const disk = createAccretionDisk();
  disk.position.y = 0.78;
  root.add(disk);

  const arches = createLensingArches();
  arches.position.y = 0.78;
  root.add(arches);

  const particles = createInfallingParticles();
  particles.position.y = 0.78;
  root.add(particles);

  const warpShell = createLensingDistortionShell();
  warpShell.position.y = 0.78;
  root.add(warpShell);

  root.userData = {
    core: horizonMesh,
    horizonGroup,
    photonRing,
    disk,
    arches,
    particles,
    warpShell
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
  const { core, horizonGroup, photonRing, disk, arches, particles, warpShell } = blackHole.userData;

  // Transform camera position into black hole local space for accurate 3D Doppler beaming
  activeCamera.getWorldPosition(tmpCamPos);
  const localCam = blackHole.worldToLocal(tmpCamPos.clone());

  // Update physical accretion disk
  if (disk?.material?.uniforms) {
    disk.material.uniforms.uTime.value = t;
    disk.material.uniforms.uGravity.value = gravity;
    disk.material.uniforms.uCamLocal.value.copy(localCam);
    disk.material.uniforms.uSpin.value = userSpin;
    disk.material.uniforms.uBrightness.value = userBrightness;
  }

  // Update lensed arches
  if (arches?.material?.uniforms) {
    arches.material.uniforms.uTime.value = t;
    arches.material.uniforms.uGravity.value = gravity;
    arches.material.uniforms.uCamLocal.value.copy(localCam);
    arches.material.uniforms.uSpin.value = userSpin;
    arches.material.uniforms.uBrightness.value = userBrightness;
  }

  // Update event horizon and photon sphere
  if (core?.material?.uniforms) {
    core.material.uniforms.uGravity.value = gravity;
    core.material.uniforms.uTime.value = t;
  }
  if (photonRing?.material?.uniforms) {
    photonRing.material.uniforms.uTime.value = t;
    photonRing.material.uniforms.uGravity.value = gravity;
    // Photon ring billboarding / orientation towards camera
    photonRing.lookAt(activeCamera.position);
  }

  // Update infalling matter particles
  if (particles?.material?.uniforms) {
    particles.material.uniforms.uTime.value = t;
    particles.material.uniforms.uGravity.value = gravity;
  }

  // Update spacetime lensing shell
  if (warpShell?.material?.uniforms) {
    warpShell.visible = enableLensingWarp;
    warpShell.material.uniforms.uGravity.value = gravity;
    warpShell.material.uniforms.uTime.value = t;
  }

  // Slow natural astrophysical rotation
  horizonGroup.rotation.y = t * 0.12 * userSpin;
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

  if (physicsBtn && physicsPanel) {
    physicsBtn.addEventListener('click', () => {
      physicsPanel.classList.toggle('active');
    });
  }

  if (infoBtn && infoDrawer) {
    infoBtn.addEventListener('click', () => {
      infoDrawer.classList.toggle('active');
    });
  }

  if (closeInfoBtn && infoDrawer) {
    closeInfoBtn.addEventListener('click', () => {
      infoDrawer.classList.remove('active');
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

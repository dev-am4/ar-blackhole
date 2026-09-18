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
let mode = 'intro'; // 'intro' | 'warp' | 'xr' | 'fallback' | 'simulator'
let moving = true;
let placed = false;
let reticleReady = false;
let launching = false;
let baseScale = 1.0;
let userMass = 1.0;
let userSpin = 0.85;
let userBrightness = 1.0;
let enableLensingWarp = true;

// Intro / Parallax state
const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
window.addEventListener('mousemove', (e) => {
  mouse.targetX = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.targetY = -(e.clientY / window.innerHeight) * 2 + 1;
});

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
let soundEnabled = false;
let jetEnabled = true;
let cameraCinematicMode = 'manual';
let targetTheta = 0.25;
let targetPhi = 1.25;
let targetRadius = 5.2;

// Simulator Orbit Controls
const simOrbit = {
  isDragging: false,
  previousMousePosition: { x: 0, y: 0 },
  theta: 0.25,
  phi: 1.25,
  radius: 5.2,
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

function toggleAudio() {
  soundEnabled = !soundEnabled;
  const soundBtn = $('#soundToggleBtn');
  if (soundBtn) {
    soundBtn.classList.toggle('sound-active', soundEnabled);
    soundBtn.textContent = soundEnabled ? '🔊 เสียงเปิด' : '🔇 เสียงปิด';
  }

  if (soundEnabled) {
    if (!audio) audio = initAudio();
    if (audio?.ctx?.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
    updateAudio(gravity);
  } else if (audio?.master) {
    audio.master.gain.setTargetAtTime(0.0001, audio.ctx.currentTime, 0.08);
  }
}

function updateAudio(strength) {
  if (!audio || !soundEnabled) {
    if (audio?.master && !soundEnabled) {
      audio.master.gain.setTargetAtTime(0.0001, audio.ctx.currentTime, 0.08);
    }
    return;
  }
  const t = audio.ctx.currentTime;
  const vol = 0.025 + strength * 0.075;
  audio.master.gain.setTargetAtTime(vol, t, 0.08);
  audio.low.frequency.setTargetAtTime(32 + strength * 32, t, 0.08);
  audio.sub.frequency.setTargetAtTime(20 + strength * 16, t, 0.08);
  audio.noiseFilter.frequency.setTargetAtTime(140 + strength * 500, t, 0.08);
  audio.noiseGain.gain.setTargetAtTime(0.02 + strength * 0.05, t, 0.08);
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
    float t = clamp(tempNorm * doppler, 0.0, 2.5);
    vec3 coolDust   = vec3(0.38, 0.05, 0.01); // 1,800 K
    vec3 redOrange  = vec3(1.00, 0.28, 0.04); // 4,000 K
    vec3 goldenWarm = vec3(1.00, 0.68, 0.22); // 7,500 K
    vec3 hotWhite   = vec3(1.00, 0.94, 0.78); // 18,000 K
    vec3 blueBeamed = vec3(0.72, 0.88, 1.00); // 45,000 K

    vec3 col = mix(coolDust, redOrange, smoothstep(0.0, 0.35, t));
    col = mix(col, goldenWarm, smoothstep(0.35, 0.75, t));
    col = mix(col, hotWhite, smoothstep(0.75, 1.35, t));
    col = mix(col, blueBeamed, smoothstep(1.35, 2.2, t));
    return col;
  }
`;

// Shared procedural cosmic starfield & nebula
const GLSL_COSMIC_STARFIELD = `
  vec3 getCosmicStarfield(vec3 dir) {
    vec3 col = vec3(0.002, 0.003, 0.008);
    
    // 1. Milky Way Galactic Plane & Core
    float galPlane = exp(-abs(dir.y) * 3.8);
    float coreGlow = exp(-abs(dir.x) * 2.2 - abs(dir.y) * 5.5) * 1.8;
    
    vec3 nebViolet = vec3(0.18, 0.05, 0.35);
    vec3 nebCyan   = vec3(0.02, 0.18, 0.32);
    vec3 nebAmber  = vec3(0.42, 0.16, 0.05);
    
    float nebNoise = snoise(dir.xy * 2.8 + vec2(dir.z * 1.5, 0.0));
    float nebPuff  = snoise(dir.zy * 4.2 - vec2(0.0, dir.x * 2.0));
    float nebTotal = clamp(nebNoise * 0.6 + nebPuff * 0.4 + 0.25, 0.0, 1.0);
    
    vec3 nebula = mix(nebViolet, nebCyan, dir.x * 0.5 + 0.5);
    nebula = mix(nebula, nebAmber, smoothstep(0.3, 0.8, nebTotal));
    col += nebula * galPlane * (0.95 + nebTotal * 0.85) + vec3(0.45, 0.22, 0.08) * coreGlow;
    
    // 2. Stars with realistic spectral classification & spikes
    vec3 p = dir * 210.0;
    vec3 fl = floor(p);
    float starRand = fract(sin(dot(fl, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
    
    if (starRand > 0.965) {
      vec3 starFrac = fract(p) - 0.5;
      float starDist = length(starFrac);
      float starBright = smoothstep(0.42, 0.02, starDist) * pow(starRand, 14.0) * 14.0;
      
      vec3 starTint = mix(vec3(0.70, 0.86, 1.0), vec3(1.0, 0.86, 0.60), fract(starRand * 27.0));
      if (fract(starRand * 13.0) > 0.82) starTint = vec3(1.0, 0.45, 0.25);
      
      if (starRand > 0.995) {
        float crossSpike = max(
          smoothstep(0.45, 0.0, abs(starFrac.x)) * smoothstep(0.08, 0.0, abs(starFrac.y)),
          smoothstep(0.45, 0.0, abs(starFrac.y)) * smoothstep(0.08, 0.0, abs(starFrac.x))
        ) * 1.6;
        starBright += crossSpike * 9.0;
      }
      col += starTint * starBright;
    }
    return col;
  }
`;

// -----------------------------------------------------------------------------
// 1. Relativistic Raymarched Black Hole (General Relativity Geodesic Raytracer)
// Simulates Schwarzschild & Kerr curved spacetime light deflection, authentic
// Gravitational Lensing arches, Doppler Beaming asymmetry, and Event Horizon shadow.
// -----------------------------------------------------------------------------
function createRelativisticRaymarchedBlackHole() {
  const geo = new THREE.SphereGeometry(4.85, 48, 48);
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
      uTilt: { value: 0.38 },
      uIsSimulator: { value: 1.0 }
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
      ${GLSL_COSMIC_STARFIELD}

      uniform float uTime;
      uniform float uGravity;
      uniform vec3 uCamLocal;
      uniform float uMass;
      uniform float uSpin;
      uniform float uBrightness;
      uniform float uEnableLensing;
      uniform float uTilt;
      uniform float uIsSimulator;

      varying vec3 vLocalPos;
      varying vec3 vWorldPos;

      float intersectSphere(vec3 o, vec3 d, float R) {
        float b = dot(o, d);
        float c = dot(o, o) - R * R;
        float disc = b * b - c;
        if (disc < 0.0) return -1.0;
        return -b - sqrt(disc);
      }

      void main() {
        vec3 o = uCamLocal;
        vec3 d = normalize(vLocalPos - uCamLocal);

        float R_BOUND = 4.80 * uMass;
        float tEnter = intersectSphere(o, d, R_BOUND);
        vec3 r = (tEnter > 0.0) ? (o + d * tEnter) : o;
        vec3 v = d;

        float rs = 0.38 * uMass;
        float rh = rs * 0.5 * (1.0 + sqrt(max(0.01, 1.0 - uSpin * uSpin * 0.72)));
        float r_isco = 3.0 * rs * (1.0 - 0.40 * uSpin);
        float r_out = 2.45 * uMass;

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

        // Dither ray start to eliminate banding and moiré artifacts
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        r += v * (0.016 * jitter);

        for (int i = 0; i < 76; i++) {
          float dist = length(r);

          if (dist <= rh) {
            hitHorizon = true;
            transmittance = 0.0;
            break;
          }

          if (dist > R_BOUND * 1.04) {
            break;
          }

          vec3 pDiskTest = tiltRot * r;
          float rDTest = length(pDiskTest.xz);
          bool inDiskZone = (abs(pDiskTest.y) < 0.18 && rDTest >= r_isco * 0.85 && rDTest <= r_out * 1.08);
          float baseDt = clamp((dist - rh * 0.94) * 0.115, 0.014, 0.11);
          float dt = inDiskZone ? min(baseDt, 0.026) : baseDt;

          if (uEnableLensing > 0.5) {
            vec3 h = cross(r, v);
            float h2 = dot(h, h);
            // Geodesic deflection (GR light bending)
            vec3 a = -1.5 * rs * h2 * r / (dist * dist * dist * dist * dist + 0.00001);
            
            // Kerr spin frame dragging (Lense-Thirring effect)
            vec3 spinAxis = invTilt * vec3(0.0, 1.0, 0.0);
            a += 0.75 * uSpin * rs * cross(v, spinAxis) / (dist * dist * dist + 0.00001);
            
            v = normalize(v + a * dt);
          }

          vec3 nextR = r + v * dt;

          vec3 pDisk = tiltRot * nextR;
          float rD = length(pDisk.xz);

          if (rD >= r_isco && rD <= r_out) {
            float hDisk = 0.028 + 0.048 * (rD - r_isco) / (r_out - r_isco);
            float vertDist = abs(pDisk.y);
            float densityProfile = exp(-0.5 * (vertDist * vertDist) / (hDisk * hDisk));

            if (densityProfile > 0.006) {
              float phi = atan(pDisk.z, pDisk.x);
              float omega = (2.4 + uGravity * 3.8 + uSpin * 2.8) * pow(r_isco / rD, 1.5);
              float rotAngle = phi - uTime * omega;

              float v_orbit = clamp(0.58 * sqrt(0.5 * rs / rD) * (1.0 + 0.25 * uSpin), 0.10, 0.76);
              vec3 orbTangentDisk = vec3(-sin(phi), 0.0, cos(phi));
              vec3 orbTangent = invTilt * orbTangentDisk;

              float cosTheta = dot(orbTangent, -v);
              float beta = v_orbit;
              float gamma = 1.0 / sqrt(max(0.001, 1.0 - beta * beta));
              float doppler = 1.0 / (gamma * (1.0 - beta * cosTheta));
              float dopplerBoost = pow(clamp(doppler, 0.15, 4.2), 3.5);

              float gravRedshift = sqrt(max(0.01, 1.0 - rs / rD));

              vec2 noiseCoord = vec2(cos(rotAngle) * rD * 3.4, sin(rotAngle) * rD * 3.4);
              float plasma = fbm(noiseCoord + vec2(rD * 2.2, uTime * 0.16));
              float streaks = sin(phi * 16.0 - uTime * omega * 1.5 + rD * 7.2) * 0.5 + 0.5;
              float density = densityProfile * (0.60 + plasma * 0.40 + streaks * 0.30);

              float tempNorm = pow((r_out - rD) / (r_out - r_isco), 1.15) * gravRedshift;
              vec3 col = getBlackbodyColor(tempNorm, doppler);

              // Ultra-bright Inner Caustic
              float iscoGlow = exp(-pow((rD - r_isco) / 0.055, 2.0)) * 3.2;
              col += vec3(1.0, 0.98, 0.92) * iscoGlow * dopplerBoost;

              float dTau = density * (0.90 + uGravity * 0.6) * uBrightness * dt * 15.0;
              float stepTrans = exp(-dTau);
              vec3 emission = col * dopplerBoost * (1.0 - stepTrans);

              colAcc += emission * transmittance;
              transmittance *= stepTrans;

              if (transmittance < 0.01) break;
            }
          }

          // Thin Photon Sphere Ring (Caustic light looping at r ~ 1.5 rs)
          if (dist > rh && dist < rh * 1.55) {
            float rPh = rh * 1.25;
            float phCaustic = exp(-pow((dist - rPh) / 0.038, 2.0)) * 0.45 * uBrightness;
            vec3 phCol = vec3(1.0, 0.94, 0.85) * phCaustic;
            colAcc += phCol * transmittance;
          }

          r = nextR;
        }

        if (hitHorizon) {
          gl_FragColor = vec4(colAcc, 1.0);
        } else {
          vec3 lensedStarfield = getCosmicStarfield(v);
          float edgeDist = length(vLocalPos);
          float edgeFade = smoothstep(R_BOUND * 0.98, R_BOUND * 0.72, edgeDist);
          
          if (uIsSimulator > 0.5) {
            vec3 finalCol = colAcc + lensedStarfield * transmittance;
            gl_FragColor = vec4(finalCol, 1.0);
          } else {
            vec3 finalCol = colAcc + lensedStarfield * transmittance * 0.20;
            float alpha = clamp(length(colAcc) * 1.3 + (1.0 - transmittance) * edgeFade, 0.0, 1.0);
            gl_FragColor = vec4(finalCol, alpha);
          }
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

// 3. Relativistic Astrophysical Jets (Synchrotron Radiation & Plasma Outflow)
function createRelativisticJets() {
  const group = new THREE.Group();
  
  const jetLength = 7.5;
  const coneGeo = new THREE.CylinderGeometry(0.04, 0.72, jetLength, 32, 16, true);
  coneGeo.translate(0, jetLength * 0.5, 0);

  const jetMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 },
      uSpin: { value: 0.85 },
      uIntensity: { value: 1.0 }
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vLocalPos;
      void main() {
        vUv = uv;
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      uniform float uGravity;
      uniform float uSpin;
      uniform float uIntensity;
      varying vec2 vUv;
      varying vec3 vLocalPos;

      void main() {
        float y = vUv.y;
        float speed = 5.2 + uGravity * 6.5 + uSpin * 3.0;
        
        // Standing shock diamonds along relativistic jet spine
        float shocks = pow(sin(y * 22.0 - uTime * speed * 0.4) * 0.5 + 0.5, 4.0) * 0.75;
        
        // Helical magnetic field twist
        float angle = atan(vLocalPos.x, vLocalPos.z);
        float helix = sin(angle * 2.0 + y * 16.0 - uTime * speed * 0.6) * 0.5 + 0.5;
        
        float rad = length(vLocalPos.xz);
        float core = exp(-rad * rad * 24.0);
        float sheath = (1.0 - y * 0.6) * (0.35 + helix * 0.45 + shocks);
        
        vec3 coreCol = vec3(0.65, 0.82, 1.0) * 2.8;
        vec3 shockCol = vec3(0.92, 0.45, 1.0) * 2.0;
        vec3 edgeCol = vec3(0.30, 0.92, 1.0);
        
        vec3 col = mix(edgeCol, shockCol, shocks);
        col = mix(col, coreCol, core);
        
        float fade = smoothstep(0.01, 0.12, y) * smoothstep(1.0, 0.45, y);
        float alpha = (core * 0.90 + sheath * 0.60) * fade * uIntensity * (0.85 + uGravity * 0.75);
        
        gl_FragColor = vec4(col * alpha, alpha);
      }
    `
  });

  const upperJet = new THREE.Mesh(coneGeo, jetMat);
  const lowerJet = new THREE.Mesh(coneGeo, jetMat);
  lowerJet.rotation.x = Math.PI;

  group.add(upperJet);
  group.add(lowerJet);

  // Relativistic particle outflow stream
  const pCount = 380;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(pCount * 3);
  const pSpeed = new Float32Array(pCount);
  const pSeed = new Float32Array(pCount);
  const pDir = new Float32Array(pCount);

  for (let i = 0; i < pCount; i++) {
    pSpeed[i] = 0.8 + Math.random() * 1.6;
    pSeed[i] = Math.random();
    pDir[i] = Math.random() > 0.5 ? 1.0 : -1.0;
  }

  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('aSpeed', new THREE.BufferAttribute(pSpeed, 1));
  pGeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));
  pGeo.setAttribute('aDir', new THREE.BufferAttribute(pDir, 1));

  const pMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 },
      uIntensity: { value: 1.0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) }
    },
    vertexShader: `
      attribute float aSpeed;
      attribute float aSeed;
      attribute float aDir;
      uniform float uTime;
      uniform float uGravity;
      uniform float uIntensity;
      uniform float uPixelRatio;
      varying float vAlpha;
      varying vec3 vColor;

      void main() {
        float speed = (2.2 + uGravity * 4.5) * aSpeed;
        float prog = fract(aSeed + uTime * speed * 0.15);
        
        float y = prog * 7.2 * aDir;
        float r = 0.04 + pow(prog, 1.4) * 0.55;
        float angle = aSeed * 6.28318 + uTime * 3.5 * aDir;
        
        vec3 p = vec3(cos(angle) * r, y, sin(angle) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        
        gl_PointSize = (3.5 + (1.0 - prog) * 4.5) * uPixelRatio * (1.2 / max(0.4, -mv.z));
        vAlpha = smoothstep(0.02, 0.15, prog) * smoothstep(1.0, 0.65, prog) * uIntensity;
        
        vec3 colCore = vec3(0.7, 0.9, 1.0);
        vec3 colTip = vec3(0.4, 0.65, 1.0);
        vColor = mix(colCore, colTip, prog);
      }
    `,
    fragmentShader: `
      precision mediump float;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float d = length(q);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.05, d) * vAlpha;
        gl_FragColor = vec4(vColor * 1.5, a);
      }
    `
  });

  const pMesh = new THREE.Points(pGeo, pMat);
  group.add(pMesh);

  group.rotation.x = -0.38;

  group.userData = {
    jetMat,
    pMat
  };

  return group;
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

  const jets = createRelativisticJets();
  jets.position.y = 0.78;
  root.add(jets);

  root.userData = {
    core,
    rayVolume,
    particles,
    jets
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

// Procedural Deep Cosmic SkyDome with Volumetric Nebula & Star Clusters
function buildCosmicSkyDome() {
  const geo = new THREE.SphereGeometry(95, 48, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vWorldDir = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      ${GLSL_COMMON_ASTRO}
      ${GLSL_COSMIC_STARFIELD}
      varying vec3 vWorldDir;
      void main() {
        vec3 dir = normalize(vWorldDir);
        vec3 col = getCosmicStarfield(dir);
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 0;
  return mesh;
}

// Deep Space Starfield & Cosmic Nebula (for 3D Simulator mode & depth)
function buildCosmicSpace() {
  const group = new THREE.Group();

  // 1. Panoramic Seamless Cosmic SkyDome
  const skyDome = buildCosmicSkyDome();
  group.add(skyDome);

  // 2. Parallax 3D Star Clusters
  const starGeo = new THREE.BufferGeometry();
  const count = 1800;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const r = 18 + Math.random() * 55;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const type = Math.random();
    if (type > 0.8) {
      colors[i * 3] = 0.70; colors[i * 3 + 1] = 0.86; colors[i * 3 + 2] = 1.0;
    } else if (type > 0.6) {
      colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.84; colors[i * 3 + 2] = 0.58;
    } else {
      colors[i * 3] = 0.95; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 0.95;
    }
  }

  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const starMat = new THREE.PointsMaterial({
    size: 0.16,
    vertexColors: true,
    transparent: true,
    opacity: 0.9
  });

  const stars = new THREE.Points(starGeo, starMat);
  group.add(stars);

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
      blackHole.position.set(0, 0, 0);
    } else {
      blackHole.position.copy(reticle.position);
    }
    blackHole.scale.setScalar(baseScale * userMass);
    blackHole.visible = true;
    reticle.visible = false;
    moving = false;
    placed = true;
    if (placeBtn) placeBtn.hidden = true;
    if (moveBtn) moveBtn.hidden = (mode === 'simulator');
    if (pulseBtn) pulseBtn.hidden = false;
    const earthSimBtn = $('#earthSimBtn');
    if (earthSimBtn) earthSimBtn.style.display = 'block';
    const labelToggleBtn = $('#labelToggleBtn');
    if (labelToggleBtn) labelToggleBtn.style.display = 'block';
    const soundToggleBtn = $('#soundToggleBtn');
    if (soundToggleBtn) soundToggleBtn.style.display = 'block';
    const cinemaBtn = $('#cinemaBtn');
    if (cinemaBtn) cinemaBtn.style.display = (mode === 'simulator') ? 'block' : 'none';
    const jetToggleBtn = $('#jetToggleBtn');
    if (jetToggleBtn) jetToggleBtn.style.display = 'block';
    const physicsBtn = $('#physicsBtn');
    if (physicsBtn) physicsBtn.style.display = 'block';
    const infoBtn = $('#infoBtn');
    if (infoBtn) infoBtn.style.display = 'block';
    const cinemaBar = $('#cinemaBar');
    if (cinemaBar && mode === 'simulator') cinemaBar.style.display = 'flex';
    if (arUI) arUI.classList.remove('ready-to-place');

    if (hint) {
      hint.style.opacity = '1';
      hint.textContent = mode === 'xr'
        ? 'เดินเข้าใกล้เพื่อเพิ่มแรงโน้มถ่วง · ใช้สองนิ้วย่อ/ขยาย'
        : mode === 'simulator'
          ? 'เลื่อนหน้าจอเพื่อหมุนมุมมอง • ซูมเข้าออกได้'
          : 'แตะค้างบนจอหรือกด “เร่งแรงดูด” · เดินเข้าใกล้หลุมดำ';
          
      // Auto-hide hint for Zero UI
      setTimeout(() => {
        hint.style.transition = 'opacity 1s ease';
        hint.style.opacity = '0';
      }, 3500);
    }
    setStatus('หลุมดำทำงาน', true);
  }
}

function moveBlackHole() {
  moving = true;
  placed = false;
  blackHole.visible = false;
  const earthSimBtn = $('#earthSimBtn');
  if (earthSimBtn) earthSimBtn.style.display = 'none';
  if (hint) {
    hint.style.transition = 'none';
    hint.style.opacity = '1';
  }
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
  if (mode === 'intro' || mode === 'warp') {
    // Cinematic gravity for intro
    gravityTarget = 0.65;
    gravity += (gravityTarget - gravity) * Math.min(1, dt * 2);
    return;
  }

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
  const { core, rayVolume, particles, jets } = blackHole.userData;

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
    rayVolume.material.uniforms.uIsSimulator.value = (mode === 'simulator' || mode === 'intro') ? 1.0 : 0.0;
  }

  // Update infalling matter particles
  if (particles?.material?.uniforms) {
    particles.material.uniforms.uTime.value = t;
    particles.material.uniforms.uGravity.value = gravity;
  }

  // Update Relativistic Polar Jets
  if (jets?.userData) {
    if (jets.userData.jetMat?.uniforms) {
      jets.userData.jetMat.uniforms.uTime.value = t;
      jets.userData.jetMat.uniforms.uGravity.value = gravity;
      jets.userData.jetMat.uniforms.uSpin.value = userSpin;
      jets.userData.jetMat.uniforms.uIntensity.value = jetEnabled ? 1.0 : 0.0;
    }
    if (jets.userData.pMat?.uniforms) {
      jets.userData.pMat.uniforms.uTime.value = t;
      jets.userData.pMat.uniforms.uGravity.value = gravity;
      jets.userData.pMat.uniforms.uIntensity.value = jetEnabled ? 1.0 : 0.0;
    }
  }
}

function renderCommon(activeCamera, now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  updateGravity(activeCamera, dt);
  animateRealisticBlackHole(now / 1000, activeCamera);
  publishScreenAnchor(blackHole, activeCamera);
  updateARLabels(activeCamera);
  updateProbes(dt, activeCamera);
  updateEarthSim(dt, activeCamera);
  updateHud(activeCamera);
}

// -----------------------------------------------------------------------------
// Spatial AR Labels Logic
// -----------------------------------------------------------------------------
let labelsVisible = false;

const arLabels = {
  horizon: { id: 'labelHorizon', offset: new THREE.Vector3(0.52, -0.32, 0), el: null },
  disk: { id: 'labelDisk', offset: new THREE.Vector3(1.85, 0.15, 0), el: null },
  photon: { id: 'labelPhoton', offset: new THREE.Vector3(-0.95, 0.65, 0), el: null }
};

function initARLabels() {
  for (const key in arLabels) {
    arLabels[key].el = $('#' + arLabels[key].id);
  }
}

function updateARLabels(activeCamera) {
  if (!blackHole || !blackHole.visible || moving || !labelsVisible) {
    for (const key in arLabels) {
      if (arLabels[key].el) arLabels[key].el.classList.remove('visible');
    }
    return;
  }

  const { core } = blackHole.userData;
  const scale = blackHole.scale.x;

  for (const key in arLabels) {
    const lbl = arLabels[key];
    if (!lbl.el) continue;

    const wPos = new THREE.Vector3();
    core.getWorldPosition(wPos);
    
    const lOff = lbl.offset.clone().multiplyScalar(scale);
    lOff.applyQuaternion(blackHole.quaternion);
    wPos.add(lOff);

    const ndc = wPos.clone().project(activeCamera);

    if (ndc.z > 1.0 || ndc.z < -1.0) {
      lbl.el.classList.remove('visible');
      continue;
    }

    const x = (ndc.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-ndc.y * 0.5 + 0.5) * window.innerHeight;

    lbl.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    lbl.el.classList.add('visible');
  }
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

function setCinematicView(viewName) {
  cameraCinematicMode = viewName;
  document.querySelectorAll('.cinema-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.view === viewName);
  });

  if (viewName === 'gargantua') {
    targetTheta = 0.05;
    targetPhi = 1.48;
    targetRadius = 5.2;
  } else if (viewName === 'jet') {
    targetTheta = 0.0;
    targetPhi = 0.32;
    targetRadius = 4.8;
  } else if (viewName === 'horizon') {
    targetTheta = 0.38;
    targetPhi = 1.35;
    targetRadius = 2.45;
  } else if (viewName === 'orbit') {
    targetRadius = 5.2;
  }
}

function renderSimulator(now) {
  if (cameraCinematicMode === 'orbit') {
    simOrbit.theta += 0.0032;
    simOrbit.phi = 1.25 + Math.sin(now * 0.0006) * 0.15;
    simOrbit.radius = THREE.MathUtils.lerp(simOrbit.radius, 5.2, 0.04);
  } else if (cameraCinematicMode !== 'manual') {
    simOrbit.theta = THREE.MathUtils.lerp(simOrbit.theta, targetTheta, 0.06);
    simOrbit.phi = THREE.MathUtils.lerp(simOrbit.phi, targetPhi, 0.06);
    simOrbit.radius = THREE.MathUtils.lerp(simOrbit.radius, targetRadius, 0.06);
  }

  // Calculate realistic distance-based gravity in simulator mode
  if (mode === 'simulator') {
    const distFromHorizon = Math.max(0.01, simOrbit.radius - 1.2);
    gravityTarget = THREE.MathUtils.clamp(1.0 - (distFromHorizon - 0.5) / 4.0, 0.15, 1.0);
  }

  updateSimulatorCamera();
  renderCommon(camera, now);
  renderer.render(scene, camera);
}

function renderIntro(now) {
  if (mode !== 'intro' && mode !== 'warp') return;
  
  // Smooth mouse interpolation
  mouse.x += (mouse.targetX - mouse.x) * 0.05;
  mouse.y += (mouse.targetY - mouse.y) * 0.05;

  if (mode === 'intro') {
    // Cinematic slow orbit & parallax
    const t = now * 0.0002;
    camera.position.x = Math.sin(t) * 0.8 + mouse.x * 0.4;
    camera.position.y = 0.78 + mouse.y * 0.4;
    camera.position.z = Math.cos(t) * 0.8 + 5.2;
    camera.lookAt(0, 0.78, 0);
  } else if (mode === 'warp') {
    // Warp transition effect
    camera.position.z *= 0.92; // Zoom in fast
    camera.fov = Math.min(camera.fov + 4, 150); // Increase FOV for hyperspace stretch
    camera.updateProjectionMatrix();
  }

  // Also rotate the blackhole slightly for dynamic background
  if (blackHole) {
    blackHole.rotation.y = now * 0.0001;
  }

  renderCommon(camera, now);
  renderer.render(scene, camera);
}

function startIntroMode() {
  mode = 'intro';
  buildScene();
  blackHole.visible = true;
  blackHole.position.set(0, 0, 0); // Center core at (0, 0.78, 0)
  gravityTarget = 0.5; // Give it some gravity to start bending light
  
  // Set initial cinematic camera
  camera.position.set(0, 0.78, 5.2);
  camera.lookAt(0, 0.78, 0);
  
  renderer.setAnimationLoop(renderIntro);
}

// -----------------------------------------------------------------------------
// Interactive 3D Simulator (Orbit, Zoom & Inspect)
// -----------------------------------------------------------------------------
function setupSimulatorControls() {
  const onPointerDown = (e) => {
    if (mode !== 'simulator' || e.target.closest('button, .physics-panel, .info-drawer, .topbar, .earth-timeline, .cinema-bar')) return;
    simOrbit.isDragging = true;
    simOrbit.previousMousePosition = { x: e.clientX || e.touches?.[0]?.clientX || 0, y: e.clientY || e.touches?.[0]?.clientY || 0 };
    cameraCinematicMode = 'manual';
    document.querySelectorAll('.cinema-pill').forEach(p => p.classList.toggle('active', p.dataset.view === 'manual'));
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
    simOrbit.radius = THREE.MathUtils.clamp(simOrbit.radius + e.deltaY * 0.0035, 2.0, 9.5);
    cameraCinematicMode = 'manual';
    document.querySelectorAll('.cinema-pill').forEach(p => p.classList.toggle('active', p.dataset.view === 'manual'));
  };

  // Two-finger pinch zoom on mobile
  let touchPinchDist = 0;
  window.addEventListener('touchstart', (e) => {
    if (mode === 'simulator' && e.touches.length === 2) {
      touchPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      cameraCinematicMode = 'manual';
      document.querySelectorAll('.cinema-pill').forEach(p => p.classList.toggle('active', p.dataset.view === 'manual'));
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (mode === 'simulator' && e.touches.length === 2 && touchPinchDist > 0) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const diff = touchPinchDist - d;
      simOrbit.radius = THREE.MathUtils.clamp(simOrbit.radius + diff * 0.008, 2.0, 9.5);
      touchPinchDist = d;
    }
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) touchPinchDist = 0;
  }, { passive: true });

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

  // Reset orbit camera to perfectly framed default
  simOrbit.radius = 5.2;
  simOrbit.theta = 0.25;
  simOrbit.phi = 1.25;
  simOrbit.target.set(0, 0.78, 0);

  camera.fov = 62;
  camera.updateProjectionMatrix();

  // Seamless transition: Auto-place the black hole
  moving = true;
  placeBlackHole();

  // Update simulator camera immediately
  updateSimulatorCamera();
  
  renderer.setAnimationLoop(renderSimulator);
  setStatus('โหมดจำลอง 3D เสมือนจริง', true);
  if (hint) {
    hint.textContent = 'เลื่อนหน้าจอเพื่อหมุนมุมมอง • ซูมเข้าออกได้';
    hint.style.opacity = '1';
    setTimeout(() => {
      hint.style.transition = 'opacity 1s ease';
      hint.style.opacity = '0';
    }, 3500);
  }
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

// -----------------------------------------------------------------------------
// Interactive Earth Infall Simulation
// -----------------------------------------------------------------------------
let earthSim = null;
let earthStage = -1;

function startEarthSimulation() {
  if (!placed || earthSim || !blackHole) return;
  
  const geo = new THREE.SphereGeometry(0.12 * baseScale, 32, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      stretch: { value: 1.0 },
      redshift: { value: 0.0 }
    },
    vertexShader: `
      uniform float stretch;
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normal;
        vec3 p = position;
        p.y *= stretch;
        p.x /= sqrt(stretch);
        p.z /= sqrt(stretch);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform float redshift;
      varying vec2 vUv;
      varying vec3 vNormal;
      
      float random(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        float a = random(i); float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0)); float d = random(i + vec2(1.0, 1.0));
        vec2 u = f*f*(3.0-2.0*f);
        return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }
      
      void main() {
        float n = noise(vUv * 15.0 + time * 0.1);
        vec3 ocean = vec3(0.02, 0.15, 0.5);
        vec3 land = vec3(0.1, 0.45, 0.2);
        vec3 col = mix(ocean, land, smoothstep(0.4, 0.55, n));
        
        float clouds = noise(vUv * 25.0 - time * 0.05);
        col = mix(col, vec3(0.9, 0.95, 1.0), smoothstep(0.6, 0.8, clouds) * 0.6);
        
        vec3 redCol = vec3(dot(col, vec3(0.33)) * 0.8, 0.05, 0.0);
        col = mix(col, redCol, redshift);
        
        float diff = max(dot(normalize(vNormal), vec3(1.0, 0.5, 1.0)), 0.15);
        gl_FragColor = vec4(col * diff * (1.0 - redshift * 0.8), 1.0);
      }
    `,
    transparent: true
  });
  
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  
  earthSim = {
    mesh,
    angle: 0,
    radius: 3.5 * baseScale,
    life: 0
  };
  
  earthStage = -1;
  const tl = document.getElementById('earthTimeline');
  if (tl) tl.classList.add('visible');
}

function updateEarthSim(dt) {
  if (!earthSim || !blackHole || !blackHole.visible) return;
  
  earthSim.life += dt;
  earthSim.mesh.material.uniforms.time.value = earthSim.life;
  
  const rs = 0.38 * userMass * baseScale;
  
  const distRatio = Math.max(0.01, earthSim.radius / rs);
  earthSim.angle += (1.0 / distRatio) * dt * 1.5;
  earthSim.radius -= (0.1 / distRatio) * dt * (userMass * 0.6);
  
  const corePos = new THREE.Vector3();
  blackHole.userData.core.getWorldPosition(corePos);
  
  const rx = Math.cos(earthSim.angle) * earthSim.radius;
  const rz = Math.sin(earthSim.angle) * earthSim.radius;
  const ry = Math.sin(earthSim.angle * 0.4) * 0.2 * earthSim.radius;
  
  earthSim.mesh.position.set(corePos.x + rx, corePos.y + ry, corePos.z + rz);
  
  const dirToCore = corePos.clone().sub(earthSim.mesh.position).normalize();
  earthSim.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirToCore);
  
  const title = document.getElementById('etTitle');
  const desc = document.getElementById('etDesc');
  
  const stageTriggers = [
    { dist: 2.8 * rs, title: "🌍 1. โลกหลุดเข้าสู่วงโคจร", desc: "แรงโน้มถ่วงมหาศาลเริ่มดึงดูดโลกของเราให้หมุนวนเข้าไปในหลุมดำ" },
    { dist: 1.8 * rs, title: "🌪️ 2. แรงไทดัลฉีกเปลือกโลก", desc: "ความโน้มถ่วงที่กระทำต่อโลกสองด้านไม่เท่ากัน เปลือกโลกเริ่มแตกและมหาสมุทรเดือด" },
    { dist: 1.2 * rs, title: "🍝 3. สปาเกตตีฟิเคชัน (Spaghettification)", desc: "มวลของโลกถูกแรงโน้มถ่วงฉีกและดึงยืดออกเป็นเส้นก๋วยเตี๋ยวอย่างรุนแรง" },
    { dist: 0.8 * rs, title: "🔴 4. ปรากฏการณ์เรดชิฟต์ (Redshift)", desc: "เวลาเดินช้าลงอย่างสุดขั้ว แสงสูญเสียพลังงานจนโลกเปลี่ยนเป็นสีแดงคล้ำ" },
    { dist: 0.45 * rs, title: "🕳️ 5. ขอบฟ้าเหตุการณ์ (Event Horizon)", desc: "จุดที่ไม่มีสิ่งใดหนีออกมาได้ โลกหายไปจากเอกภพของเราตลอดกาล..." }
  ];
  
  let currentStage = -1;
  for (let i = stageTriggers.length - 1; i >= 0; i--) {
    if (earthSim.radius <= stageTriggers[i].dist) {
      currentStage = i;
      break;
    }
  }
  
  if (currentStage > earthStage) {
    earthStage = currentStage;
    if (title && desc) {
      title.textContent = stageTriggers[currentStage].title;
      desc.textContent = stageTriggers[currentStage].desc;
    }
  }
  
  if (earthSim.radius < 1.4 * rs) {
    const stretch = 1.0 + Math.pow(1.4 * rs / Math.max(earthSim.radius, 0.1), 4.0);
    earthSim.mesh.material.uniforms.stretch.value = Math.min(stretch, 25.0);
  }
  
  if (earthSim.radius < 1.0 * rs) {
    const redshift = 1.0 - (earthSim.radius / rs);
    earthSim.mesh.material.uniforms.redshift.value = Math.min(redshift * 1.5, 1.0);
  }
  
  if (earthSim.radius < 0.38 * rs) {
    scene.remove(earthSim.mesh);
    earthSim.mesh.geometry.dispose();
    earthSim.mesh.material.dispose();
    earthSim = null;
    
    setTimeout(() => {
      const tl = document.getElementById('earthTimeline');
      if (tl) tl.classList.remove('visible');
    }, 4000);
  }
}

// -----------------------------------------------------------------------------
// Interactive Probes (Spaghettification & Redshift)
// -----------------------------------------------------------------------------
const probes = [];

function shootProbe(e) {
  const clientX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
  const clientY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
  
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1
  );

  raycaster.setFromCamera(ndc, camera);
  
  // Create probe mesh
  const geometry = new THREE.SphereGeometry(0.02, 16, 16);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geometry, material);
  
  // Start slightly in front of camera
  mesh.position.copy(camera.position).add(raycaster.ray.direction.clone().multiplyScalar(0.5));
  scene.add(mesh);

  probes.push({
    mesh,
    velocity: raycaster.ray.direction.clone().multiplyScalar(4.0), // Initial speed
    life: 0
  });
}

function updateProbes(dt, activeCamera) {
  if (!blackHole || !blackHole.visible) return;
  
  const corePos = new THREE.Vector3();
  blackHole.userData.core.getWorldPosition(corePos);
  
  const rs = 0.38 * userMass * baseScale; // Schwarzschild radius (approx)

  for (let i = probes.length - 1; i >= 0; i--) {
    const p = probes[i];
    p.life += dt;

    const dirToCore = corePos.clone().sub(p.mesh.position);
    const dist = dirToCore.length();
    
    // Gravity attraction
    const gravityForce = dirToCore.normalize().multiplyScalar(10.0 * userMass / (dist * dist));
    p.velocity.add(gravityForce.multiplyScalar(dt));

    // Time Dilation: As it gets closer to rs, it slows down visually
    const timeDilation = Math.max(0.01, Math.sqrt(Math.max(0.001, 1.0 - (rs / dist))));
    
    // Move probe
    p.mesh.position.add(p.velocity.clone().multiplyScalar(dt * timeDilation));

    // Spaghettification (Stretch along velocity vector)
    const speed = p.velocity.length();
    if (speed > 0.1) {
      p.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.velocity.clone().normalize());
      // Stretch more as it gets closer
      const stretch = 1.0 + (rs / Math.max(dist, rs)) * 15.0;
      p.mesh.scale.set(1.0 / stretch, stretch, 1.0 / stretch);
    }

    // Gravitational Redshift (White -> Yellow -> Red -> Dark Red)
    const redshiftFactor = Math.max(0, 1.0 - (rs / dist));
    p.mesh.material.color.setHSL(0.0, 1.0, redshiftFactor * 0.5 + 0.1);

    // Remove if it crosses event horizon or lives too long
    if (dist < rs * 1.05 || p.life > 10) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      probes.splice(i, 1);
    }
  }
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
  startBtn.textContent = 'เตรียมเข้าสู่อวกาศ...';

  // Trigger Warp Effect
  mode = 'warp';
  intro.style.opacity = '0';
  intro.style.transition = 'opacity 0.8s ease';
  
  // Create a cinematic flash
  const flash = document.createElement('div');
  flash.className = 'flash-overlay active';
  document.body.appendChild(flash);
  
  setTimeout(() => flash.classList.remove('active'), 800);

  setTimeout(async () => {
    try {
      intro.style.display = 'none';
      arUI.classList.add('on');
      setStatus('กำลังตรวจ AR', false);

      // Reset camera from warp
      camera.fov = 62;
      camera.updateProjectionMatrix();

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
      startSimulatorMode();
    }
  }, 1000); // 1 second warp delay
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
  initARLabels();

  const simIntroBtn = $('#simIntroBtn');
  if (simIntroBtn) {
    simIntroBtn.addEventListener('click', () => {
      audio = initAudio();
      
      mode = 'warp';
      intro.style.opacity = '0';
      intro.style.transition = 'opacity 0.8s ease';
      
      const flash = document.createElement('div');
      flash.className = 'flash-overlay active';
      document.body.appendChild(flash);
      setTimeout(() => flash.classList.remove('active'), 800);

      setTimeout(() => {
        intro.style.display = 'none';
        arUI.classList.add('on');
        camera.fov = 62;
        camera.updateProjectionMatrix();
        startSimulatorMode();
      }, 1000);
    });
  }

  // Earth Sim
  const earthSimBtn = $('#earthSimBtn');
  if (earthSimBtn) {
    earthSimBtn.addEventListener('click', startEarthSimulation);
  }

  // Snapshot functionality
  const snapshotBtn = $('#snapshotBtn');
  const flashOverlay = $('#flashOverlay');
  if (snapshotBtn) {
    snapshotBtn.addEventListener('click', () => {
      // Hide UI
      document.querySelector('.topbar').style.display = 'none';
      document.getElementById('arLabels').style.display = 'none';
      
      // Wait a frame for UI to hide, then capture
      setTimeout(() => {
        const canvas = renderer.domElement;
        const imgData = canvas.toDataURL('image/png');
        
        // Show flash
        if (flashOverlay) {
          flashOverlay.classList.add('active');
          setTimeout(() => flashOverlay.classList.remove('active'), 50);
        }

        // Restore UI
        document.querySelector('.topbar').style.display = 'flex';
        document.getElementById('arLabels').style.display = 'block';

        // Trigger download
        const link = document.createElement('a');
        link.download = 'blackhole_snapshot.png';
        link.href = imgData;
        link.click();
      }, 50);
    });
  }

  // Shoot probes on tap (AR modes only, so dragging in simulator doesn't spawn probes)
  window.addEventListener('pointerdown', (e) => {
    if ((mode !== 'xr' && mode !== 'fallback') || !placed) return;
    if (e.target.closest('button, .physics-panel, .info-drawer, .ar-label, .topbar')) return;
    shootProbe(e);
  });

  // Spatial Labels Toggle
  const labelToggleBtn = $('#labelToggleBtn');
  if (labelToggleBtn) {
    labelToggleBtn.addEventListener('click', () => {
      labelsVisible = !labelsVisible;
      labelToggleBtn.classList.toggle('active', labelsVisible);
      labelToggleBtn.textContent = labelsVisible ? '🏷️ ซ่อนป้าย' : '🏷️ ป้ายกำกับ';
      updateARLabels(camera);
    });
  }

  // Sound Toggle
  const soundToggleBtn = $('#soundToggleBtn');
  if (soundToggleBtn) {
    soundToggleBtn.addEventListener('click', toggleAudio);
  }

  // Cinematic Camera Toggle & Views
  const cinemaBtn = $('#cinemaBtn');
  const cinemaBar = $('#cinemaBar');
  if (cinemaBtn) {
    cinemaBtn.addEventListener('click', () => {
      if (cinemaBar) {
        cinemaBar.style.display = cinemaBar.style.display === 'none' ? 'flex' : 'none';
      }
    });
  }

  document.querySelectorAll('.cinema-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      setCinematicView(pill.dataset.view);
    });
  });

  // Relativistic Jet Toggle
  const jetToggleBtn = $('#jetToggleBtn');
  if (jetToggleBtn) {
    jetToggleBtn.addEventListener('click', () => {
      jetEnabled = !jetEnabled;
      jetToggleBtn.classList.toggle('active', jetEnabled);
      jetToggleBtn.textContent = jetEnabled ? '⚡ ลำพลาสมา [เปิด]' : '⚡ ลำพลาสมา [ปิด]';
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
startIntroMode();

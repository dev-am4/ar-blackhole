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

const PARAMS = new URLSearchParams(location.search);
const DEBUG = PARAMS.has('debug');
const KIOSK = PARAMS.has('kiosk');
const CINEMATIC_OVERLAY = PARAMS.get('cinematic') === '1';
const FORCE_CAMERA_FALLBACK = PARAMS.get('camera') === '1';
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MOBILE_DEVICE = matchMedia('(pointer:coarse)').matches
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const LOW_POWER_MOBILE = MOBILE_DEVICE && (
  (navigator.deviceMemory && navigator.deviceMemory <= 4)
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 6)
);
const MAX_PIXEL_RATIO = LOW_POWER_MOBILE ? 1.0 : MOBILE_DEVICE ? 1.25 : 2.0;
const RAYMARCH_STEPS = LOW_POWER_MOBILE ? 40 : MOBILE_DEVICE ? 52 : 76;
const FBM_OCTAVES = MOBILE_DEVICE ? 3 : 4;
document.documentElement.dataset.device = MOBILE_DEVICE ? 'mobile' : 'desktop';
if (IS_IOS) document.documentElement.dataset.ios = '1';
if (DEBUG && hud) hud.classList.add('on');
if (KIOSK) document.documentElement.dataset.kiosk = '1';

const prefersDesktopSimulator = () =>
  matchMedia('(pointer:fine)').matches &&
  !matchMedia('(pointer:coarse)').matches &&
  !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const modeHint = $('#modeHint');
if (modeHint) modeHint.textContent = 'เลือกวิธีสำรวจหลุมดำ';

let cinematicLoadPromise = null;
function ensureCinematicLayer() {
  // The generated cinematic WebP contains its own black-hole image.
  // Never stack it over the native Three.js black hole in production.
  // Keep it available only as an explicit diagnostic/creative mode.
  if (!CINEMATIC_OVERLAY) {
    document.querySelector('#cinematicBlackHoleWrap')?.remove();
    return Promise.resolve();
  }
  if (cinematicLoadPromise || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return cinematicLoadPromise || Promise.resolve();
  }
  cinematicLoadPromise = new Promise((resolve) => {
    if (!document.querySelector('link[data-cinematic]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/cinematic-video.css?v=2';
      link.dataset.cinematic = '1';
      document.head.appendChild(link);
    }
    if (document.querySelector('script[data-cinematic]')) return resolve();
    const script = document.createElement('script');
    script.src = '/cinematic-video.js?v=2';
    script.dataset.cinematic = '1';
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.body.appendChild(script);
  });
  return cinematicLoadPromise;
}

let kioskIdleTimer = 0;
function resetKioskIdle() {
  if (!KIOSK) return;
  clearTimeout(kioskIdleTimer);
  if (mode === 'intro' || mode === 'warp') return;
  kioskIdleTimer = setTimeout(() => location.reload(), 45000);
}
['pointerdown','touchstart','keydown'].forEach((name) => {
  addEventListener(name, (e) => {
    if (e.isTrusted) resetKioskIdle();
  }, { capture:true, passive:name !== 'keydown' });
});

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

// Visitor experience: only two public paths.
let visitorExperience = 'intro'; // intro | ar | lab
let formationStar = null;
let arStoryStart = 0;
let arStoryRunning = false;
let arStoryStage = -1;

function setVisitorExperience(name) {
  visitorExperience = name;
  document.documentElement.dataset.experience = name;
  const badge = $('#experienceBadge');
  if (badge) badge.textContent = name === 'lab' ? 'BLACK HOLE LAB' : name === 'ar' ? 'AR VIEW' : '';

  const snap = $('#snapshotBtn');
  if (snap) snap.style.display = (name === 'ar' || name === 'lab') ? 'none' : '';
}

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
let soundEnabled = true;
let audioNarrativeIntensity = 0.18;
let audioPhase = 'ambient';
let audioDuckUntil = 0;
let arHorizonDuckDone = false;
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

const labOrbit = {
  theta: 0.18,
  phi: 1.34,
  radius: 6.25,
  target: new THREE.Vector3(0, 0.48, 0)
};
let labCameraLastFrame = performance.now();

function defaultLabRadius() {
  return (innerHeight > innerWidth && innerWidth <= 700) ? 7.5 : 6.25;
}

function resetLabCamera(immediate = false) {
  labOrbit.theta = 0.18;
  labOrbit.phi = 1.34;
  labOrbit.radius = defaultLabRadius();
  labOrbit.target.set(0, 0.48, 0);

  if (immediate) {
    simOrbit.theta = labOrbit.theta;
    simOrbit.phi = labOrbit.phi;
    simOrbit.radius = labOrbit.radius;
    simOrbit.target.copy(labOrbit.target);
  }

  labCameraLastFrame = performance.now();
}

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
// Original cinematic space score engine
// Organ-like drone + slow pulse + air texture + event swells.
// No sampled soundtrack and no copied melody.
// -----------------------------------------------------------------------------
function makeImpulseResponse(ctx, seconds = 2.8, decay = 2.6) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch=0; ch<2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i=0; i<length; i++) {
      const t = i / length;
      data[i] = (Math.random()*2-1) * Math.pow(1-t,decay) * 0.32;
    }
  }
  return buffer;
}

function initAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.0001;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 24;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.42;

    const dry = ctx.createGain();
    dry.gain.value = .88;
    const wet = ctx.createGain();
    wet.gain.value = .18;
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulseResponse(ctx);

    dry.connect(compressor);
    convolver.connect(wet).connect(compressor);
    compressor.connect(master).connect(ctx.destination);

    const organGain = ctx.createGain();
    organGain.gain.value = .03;
    const organFilter = ctx.createBiquadFilter();
    organFilter.type = 'lowpass';
    organFilter.frequency.value = 1100;
    organFilter.Q.value = .55;
    organGain.connect(organFilter);
    organFilter.connect(dry);
    organFilter.connect(convolver);

    // Open fifth / suspended chord voicing; intentionally no melody.
    const organFreqs = [73.42, 110.0, 146.83, 220.0];
    const organOscs = organFreqs.map((freq,i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = i < 2 ? 'sine' : 'triangle';
      o.frequency.value = freq;
      o.detune.value = [-5,3,-2,5][i];
      g.gain.value = [0.34,0.22,0.13,0.055][i];
      o.connect(g).connect(organGain);
      o.start();
      return {o,g};
    });

    // Upper register fades in only as tension rises.
    const highRegisterGain = ctx.createGain();
    highRegisterGain.gain.value = .0001;
    highRegisterGain.connect(organFilter);
    const highFreqs = [293.66, 440.0];
    const highOscs = highFreqs.map((freq,i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.frequency.value = freq;
      o.detune.value = i === 0 ? -3 : 4;
      g.gain.value = i === 0 ? .20 : .08;
      o.connect(g).connect(highRegisterGain);
      o.start();
      return {o,g};
    });

    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.value = 36.71;
    subGain.gain.value = .045;
    sub.connect(subGain).connect(dry);
    sub.start();

    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1,bufferSize,ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let brown=0;
    for(let i=0;i<bufferSize;i++){
      const white=Math.random()*2-1;
      brown=(brown + .02*white)/1.02;
      output[i]=brown*2.2;
    }
    const air = ctx.createBufferSource();
    air.buffer=noiseBuffer;
    air.loop=true;
    const airFilter=ctx.createBiquadFilter();
    airFilter.type='bandpass';
    airFilter.frequency.value=620;
    airFilter.Q.value=.6;
    const airGain=ctx.createGain();
    airGain.gain.value=.008;
    air.connect(airFilter).connect(airGain);
    airGain.connect(dry);
    airGain.connect(convolver);
    air.start();

    const pulse = () => {
      if (!soundEnabled || ctx.state !== 'running') return;
      const now=ctx.currentTime;
      const o=ctx.createOscillator();
      const g=ctx.createGain();
      const f=ctx.createBiquadFilter();
      o.type='sine';
      o.frequency.setValueAtTime(180,now);
      o.frequency.exponentialRampToValueAtTime(72,now+.16);
      f.type='lowpass';
      f.frequency.value=620;
      const amp=.008 + audioNarrativeIntensity*.025;
      g.gain.setValueAtTime(.0001,now);
      g.gain.exponentialRampToValueAtTime(amp,now+.012);
      g.gain.exponentialRampToValueAtTime(.0001,now+.22);
      o.connect(f).connect(g).connect(dry);
      o.start(now);
      o.stop(now+.24);
    };
    const pulseTimer=setInterval(pulse,1250);

    ctx.resume().catch(()=>{});
    return {ctx,master,dry,wet,convolver,organGain,organFilter,organOscs,highRegisterGain,highOscs,sub,subGain,airFilter,airGain,pulseTimer};
  } catch {
    return null;
  }
}

function syncSoundButton() {
  const compact=$('#experienceSoundBtn');
  if(compact){
    compact.classList.toggle('sound-active',soundEnabled);
    compact.textContent=soundEnabled?'🔊':'🔇';
    compact.setAttribute('aria-pressed',soundEnabled?'true':'false');
  }
  const legacy=$('#soundToggleBtn');
  if(legacy){
    legacy.classList.toggle('sound-active',soundEnabled);
    legacy.textContent=soundEnabled?'🔊 เสียงเปิด':'🔇 เสียงปิด';
  }
}

function enableExperienceAudio() {
  soundEnabled=true;
  if(!audio) audio=initAudio();
  audio?.ctx?.resume?.().catch(()=>{});
  syncSoundButton();
  updateAudio(gravity);
}

function toggleAudio() {
  soundEnabled=!soundEnabled;
  if(soundEnabled){
    if(!audio) audio=initAudio();
    audio?.ctx?.resume?.().catch(()=>{});
    updateAudio(gravity);
  } else if(audio?.master) {
    audio.master.gain.setTargetAtTime(.0001,audio.ctx.currentTime,.12);
  }
  syncSoundButton();
}

function triggerCollapseImpact() {
  if(!audio || !soundEnabled) return;
  const {ctx,dry,convolver}=audio;
  const now=ctx.currentTime;
  const osc=ctx.createOscillator();
  const gain=ctx.createGain();
  osc.type='sine';
  osc.frequency.setValueAtTime(72,now);
  osc.frequency.exponentialRampToValueAtTime(28,now+.65);
  gain.gain.setValueAtTime(.0001,now);
  gain.gain.exponentialRampToValueAtTime(.13,now+.025);
  gain.gain.exponentialRampToValueAtTime(.0001,now+.9);
  osc.connect(gain);
  gain.connect(dry);
  gain.connect(convolver);
  osc.start(now);
  osc.stop(now+.95);
}

function prepareHorizonSilence(duration=.72) {
  if(!audio || !soundEnabled) return;
  const now=audio.ctx.currentTime;
  audioDuckUntil=Math.max(audioDuckUntil,now+duration);
  audio.master.gain.cancelScheduledValues(now);
  audio.master.gain.setTargetAtTime(.0035,now,.09);
}

function triggerHorizonSwell(delay=0) {
  if(!audio || !soundEnabled) return;
  const {ctx,dry,convolver}=audio;
  const now=ctx.currentTime+Math.max(0,delay);
  const o=ctx.createOscillator();
  const g=ctx.createGain();
  o.type='triangle';
  o.frequency.setValueAtTime(88,now);
  o.frequency.exponentialRampToValueAtTime(29,now+2.5);
  g.gain.setValueAtTime(.0001,now);
  g.gain.exponentialRampToValueAtTime(.13,now+.42);
  g.gain.exponentialRampToValueAtTime(.0001,now+2.8);
  o.connect(g);
  g.connect(dry);
  g.connect(convolver);
  o.start(now);
  o.stop(now+2.9);
}

function setAudioPhase(phase) {
  audioPhase=phase;
  const map={
    ambient:.18,
    star:.22,
    collapse:.42,
    blackhole:.55,
    accretion:.66,
    lensing:.78,
    far:.25,
    gravity:.46,
    tidal:.70,
    horizon:1.0
  };
  audioNarrativeIntensity=map[phase] ?? .3;
  if(phase==='collapse') triggerCollapseImpact();
  if(phase==='horizon') {
    const delay = audio?.ctx ? Math.max(0,audioDuckUntil-audio.ctx.currentTime) : 0;
    triggerHorizonSwell(delay);
  }
  updateAudio(gravity);
}

function updateAudio(strength) {
  if(!audio || !soundEnabled){
    if(audio?.master && !soundEnabled){
      audio.master.gain.setTargetAtTime(.0001,audio.ctx.currentTime,.12);
    }
    return;
  }
  const t=audio.ctx.currentTime;
  const intensity=Math.max(.12,Math.min(1,Math.max(strength*.72,audioNarrativeIntensity)));
  const volume=.028 + intensity*.052;
  const ducking = t < audioDuckUntil;
  audio.master.gain.setTargetAtTime(ducking ? .0035 : volume,t,ducking ? .06 : .28);
  audio.organGain.gain.setTargetAtTime(.025 + intensity*.052,t,.45);
  audio.highRegisterGain?.gain.setTargetAtTime(
    Math.max(.0001,(intensity-.42)*.052),
    t,
    .55
  );
  audio.subGain.gain.setTargetAtTime(.026 + intensity*.075,t,.32);
  audio.organFilter.frequency.setTargetAtTime(720 + intensity*1280,t,.5);
  audio.airFilter.frequency.setTargetAtTime(420 + intensity*1050,t,.4);
  audio.airGain.gain.setTargetAtTime(.004 + intensity*.020,t,.4);
  audio.wet.gain.setTargetAtTime(.12 + intensity*.13,t,.55);
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
    for (int i = 0; i < ${FBM_OCTAVES}; ++i) {
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
  const geo = new THREE.SphereGeometry(
    4.85,
    MOBILE_DEVICE ? 32 : 48,
    MOBILE_DEVICE ? 24 : 48
  );
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
        float minDist = 1e9;

        // Dither ray start to eliminate banding and moiré artifacts
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        r += v * (0.016 * jitter);

        for (int i = 0; i < ${RAYMARCH_STEPS}; i++) {
          float dist = length(r);
          minDist = min(minDist, dist);

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

          // Thin photon-ring caustic kept OUTSIDE the apparent black-hole shadow.
          // This prevents the bright caustic from bleeding into the dark center.
          if (dist > rh * 1.62 && dist < rh * 2.20) {
            float rPh = rh * 1.82;
            float ringWidth = 0.030 * max(uMass, 0.55);
            float phCaustic = exp(-pow((dist - rPh) / ringWidth, 2.0)) * 0.52 * uBrightness;
            vec3 phCol = vec3(1.0, 0.94, 0.85) * phCaustic;
            colAcc += phCol * transmittance;
          }

          r = nextR;
        }

        // Apparent black-hole shadow:
        // any ray captured by the horizon OR passing inside the capture-shadow
        // region must remain optically black. Never output accumulated disk light here.
        float shadowRadius = rh * 1.55;
        bool insideShadow = hitHorizon || (minDist < shadowRadius);

        if (insideShadow) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
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
function createInfallingParticles(count = MOBILE_DEVICE ? 420 : 850) {
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
  const pCount = MOBILE_DEVICE ? 170 : 380;
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
    new THREE.RingGeometry(0.18, 0.22, MOBILE_DEVICE ? 32 : 64),
    new THREE.MeshBasicMaterial({ color: 0x8ddcff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  outer.rotation.x = -Math.PI / 2;
  group.add(outer);

  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.035, 0.05, MOBILE_DEVICE ? 24 : 48),
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
  const geo = new THREE.SphereGeometry(95, MOBILE_DEVICE ? 32 : 48, MOBILE_DEVICE ? 20 : 32);
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
  const count = MOBILE_DEVICE ? 850 : 1800;
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
// AR cinematic story · one concise scientific sequence
// -----------------------------------------------------------------------------
function makeFormationStar() {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, MOBILE_DEVICE ? 24 : 36, MOBILE_DEVICE ? 18 : 28),
    new THREE.MeshBasicMaterial({ color:0xffe6b0 })
  );
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.48, MOBILE_DEVICE ? 20 : 32, MOBILE_DEVICE ? 14 : 22),
    new THREE.MeshBasicMaterial({
      color:0xff9b4a,
      transparent:true,
      opacity:.18,
      blending:THREE.AdditiveBlending,
      depthWrite:false
    })
  );
  group.add(core,halo);
  return group;
}

function removeFormationStar() {
  if (!formationStar) return;
  formationStar.traverse((child) => {
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  });
  formationStar.parent?.remove(formationStar);
  formationStar = null;
}

const AR_STORY = [
  {
    at:0,
    step:'01 · MASSIVE STAR',
    title:'ดาวฤกษ์มวลมาก',
    text:'หลุมดำมวลดาวฤกษ์บางส่วนเริ่มต้นจากดาวฤกษ์มวลมาก'
  },
  {
    at:4,
    step:'02 · STELLAR COLLAPSE',
    title:'แกนดาวยุบตัว',
    text:'เมื่อเชื้อเพลิงหมด แกนของดาวบางดวงอาจยุบตัวภายใต้แรงโน้มถ่วง'
  },
  {
    at:7,
    step:'03 · BLACK HOLE',
    title:'หลุมดำก่อตัว',
    text:'บริเวณใจกลางกลายเป็นเงามืดที่แสงจากภายในไม่สามารถกลับออกมาได้'
  },
  {
    at:11,
    step:'04 · ACCRETION DISK',
    title:'สสารหมุนวนและร้อนขึ้น',
    text:'ก๊าซรอบหลุมดำอาจก่อตัวเป็นจานสะสมมวลที่ร้อนและสว่าง'
  },
  {
    at:16,
    step:'05 · LIGHT BENDS',
    title:'เส้นทางของแสงโค้ง',
    text:'มวลมหาศาลทำให้กาล-อวกาศโค้ง จึงเห็นแสงด้านหลังบิดอ้อมหลุมดำ'
  },
  {
    at:21,
    step:'06 · EVENT HORIZON',
    title:'ขอบฟ้าเหตุการณ์',
    text:'เมื่อผ่านขอบเขตนี้แล้ว ไม่มีแสงหรือสัญญาณใดกลับออกมาถึงผู้สังเกตภายนอกได้'
  }
];

function setARStoryStage(index) {
  if (index === arStoryStage || index < 0 || index >= AR_STORY.length) return;
  arStoryStage = index;
  const data = AR_STORY[index];
  const panel = $('#arStory');
  panel?.classList.add('active');
  panel?.setAttribute('aria-hidden','false');
  if ($('#arStoryStep')) $('#arStoryStep').textContent = data.step;
  if ($('#arStoryTitle')) $('#arStoryTitle').textContent = data.title;
  if ($('#arStoryText')) $('#arStoryText').textContent = data.text;
}

function startARStory() {
  if (!blackHole || visitorExperience !== 'ar') return;
  removeFormationStar();

  formationStar = makeFormationStar();
  formationStar.position.copy(blackHole.position);
  formationStar.position.y += .78 * baseScale;
  formationStar.scale.setScalar(baseScale);
  scene.add(formationStar);

  blackHole.visible = false;
  blackHole.scale.setScalar(baseScale * userMass * .3);
  if (blackHole.userData.particles) blackHole.userData.particles.visible = false;
  if (blackHole.userData.jets) blackHole.userData.jets.visible = false;

  userBrightness = .12;
  enableLensingWarp = false;
  jetEnabled = false;

  arStoryStart = performance.now();
  arStoryRunning = true;
  arStoryStage = -1;
  arHorizonDuckDone = false;
  setARStoryStage(0);
  setAudioPhase('star');

  if (moveBtn) moveBtn.hidden = true;
  if ($('#snapshotBtn')) $('#snapshotBtn').style.display = 'none';
  setStatus('กำลังเล่าเรื่องหลุมดำ', true);
}

function finishARStory() {
  arStoryRunning = false;
  removeFormationStar();

  blackHole.visible = true;
  blackHole.scale.setScalar(baseScale * userMass);
  if (blackHole.userData.particles) blackHole.userData.particles.visible = true;
  if (blackHole.userData.jets) blackHole.userData.jets.visible = false;

  userBrightness = 1.0;
  enableLensingWarp = true;

  const panel = $('#arStory');
  panel?.classList.remove('active');
  panel?.setAttribute('aria-hidden','true');

  if (moveBtn) {
    moveBtn.hidden = false;
    moveBtn.textContent = 'วางใหม่';
  }
  if ($('#snapshotBtn')) $('#snapshotBtn').style.display = '';
  if (hint) {
    hint.style.opacity = '1';
    hint.textContent = 'หลุมดำพร้อมแล้ว · ถ่ายภาพ หรือวางใหม่';
    setTimeout(() => { if (hint) hint.style.opacity = '0'; }, 3200);
  }
  setAudioPhase('ambient');
  setStatus('AR · BLACK HOLE', true);
}

function updateARStory(now) {
  if (!arStoryRunning || visitorExperience !== 'ar' || !blackHole) return;
  const t = (now - arStoryStart) / 1000;

  let stage = 0;
  for (let i=0;i<AR_STORY.length;i++) {
    if (t >= AR_STORY[i].at) stage = i;
  }
  setARStoryStage(stage);
  const storyAudioPhases=['star','collapse','blackhole','accretion','lensing','horizon'];
  if (storyAudioPhases[stage] && audioPhase !== storyAudioPhases[stage]) {
    setAudioPhase(storyAudioPhases[stage]);
  }

  const progress = Math.min(1,t/25);
  if ($('#arStoryProgress')) $('#arStoryProgress').style.transform = 'scaleX(' + progress + ')';

  if (formationStar) {
    const collapse = THREE.MathUtils.clamp((t - 4) / 3,0,1);
    const pulse = 1 + Math.sin(t * 5) * .035 * (1-collapse);
    formationStar.scale.setScalar(baseScale * THREE.MathUtils.lerp(pulse,.06,collapse));
    formationStar.rotation.y += .008;
    formationStar.visible = t < 7.1;
  }

  if (t >= 6.2) {
    blackHole.visible = true;
    const reveal = THREE.MathUtils.smoothstep(t,6.2,9.5);
    blackHole.scale.setScalar(baseScale * userMass * THREE.MathUtils.lerp(.22,1,reveal));
    userBrightness = THREE.MathUtils.lerp(.08, t >= 11 ? 1.0 : .24, THREE.MathUtils.clamp((t-7)/5,0,1));
  }

  if (t >= 11 && blackHole.userData.particles) blackHole.userData.particles.visible = true;
  if (t >= 16) enableLensingWarp = true;

  if (t >= 20.15 && !arHorizonDuckDone) {
    arHorizonDuckDone = true;
    prepareHorizonSilence(.72);
  }

  if (t >= 25) finishARStory();
}

function showLabExperience() {
  setVisitorExperience('lab');
  cameraCinematicMode = 'manual';
  resetLabCamera(true);
  const rail = $('#labStageRail');
  rail?.classList.add('active');
  rail?.setAttribute('aria-hidden','false');
  const tag = $('#labObjectTag');
  tag?.classList.remove('active');
  tag?.setAttribute('aria-hidden','true');
  updateLabPhaseUI('far');

  const panel = $('#experimentPanel');
  panel?.classList.add('active');
  panel?.setAttribute('aria-hidden','false');

  if ($('#snapshotBtn')) $('#snapshotBtn').style.display = 'none';
  if (placeBtn) placeBtn.hidden = true;
  if (moveBtn) moveBtn.hidden = true;
  if (pulseBtn) pulseBtn.hidden = true;
  if ($('#toolsBtn')) $('#toolsBtn').hidden = true;

  if (hint) {
    hint.style.transition = 'none';
    hint.style.opacity = '1';
    hint.textContent = 'เลือกวัตถุ · ลากเพื่อหมุน · หนีบสองนิ้วเพื่อซูม';
  }
  setStatus('BLACK HOLE LAB', true);
}

// -----------------------------------------------------------------------------
// Scene & Renderer Initialization
// -----------------------------------------------------------------------------
function buildScene() {
  if (scene) return;
  scene = new THREE.Scene();

  // Lab objects use physically lit materials; the black-hole shader itself
  // is self-lit and is unaffected by these lights.
  const labAmbient = new THREE.HemisphereLight(0xdbe9ff, 0x16101f, 2.2);
  const labKey = new THREE.DirectionalLight(0xffffff, 3.0);
  labKey.position.set(3, 5, 4);
  scene.add(labAmbient, labKey);

  camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.01, 120);
  camera.position.set(0, EYE_HEIGHT, 0);

  renderer = new THREE.WebGLRenderer({
    antialias: !LOW_POWER_MOBILE,
    alpha: true,
    powerPreference: 'high-performance',
    precision: MOBILE_DEVICE ? 'mediump' : 'highp'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
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
      blackHole.userData.particles.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
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
    if (pulseBtn) pulseBtn.hidden = true;
    if ($('#toolsBtn')) $('#toolsBtn').hidden = true;
    $('#toolTray')?.classList.remove('active');
    $('#missionPanel')?.classList.remove('active');
    $('#physicsPanel')?.classList.remove('active');
    $('#infoDrawer')?.classList.remove('active');
    $('#cinemaBar')?.style && ($('#cinemaBar').style.display = 'none');
    if (arUI) arUI.classList.remove('ready-to-place');
    resetKioskIdle();

    if (visitorExperience === 'lab') {
      showLabExperience();
    } else {
      if (moveBtn) moveBtn.hidden = true;
      if (hint) {
        hint.style.transition = 'opacity .2s ease';
        hint.style.opacity = '0';
      }
      startARStory();
    }
  }
}

function moveBlackHole() {
  arStoryRunning = false;
  removeFormationStar();
  $('#arStory')?.classList.remove('active');
  clearGravityLab();
  moving = true;
  placed = false;
  blackHole.visible = false;
  const earthSimBtn = $('#earthSimBtn');
  if (earthSimBtn) earthSimBtn.style.display = 'none';
  const experimentPanel = $('#experimentPanel');
  experimentPanel?.classList.remove('active');
  experimentPanel?.setAttribute('aria-hidden','true');
  const missionPanel = $('#missionPanel');
  missionPanel?.classList.remove('active');
  missionPanel?.setAttribute('aria-hidden','true');
  cancelMission(false);
  if (hint) {
    hint.style.transition = 'none';
    hint.style.opacity = '1';
  }
  if (placeBtn) placeBtn.hidden = false;
  if (moveBtn) moveBtn.hidden = true;
  if (pulseBtn) pulseBtn.hidden = true;
  const toolsBtn = $('#toolsBtn');
  const toolTray = $('#toolTray');
  if (toolsBtn) {
    toolsBtn.hidden = true;
    toolsBtn.classList.remove('active');
  }
  toolTray?.classList.remove('active');
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

let mobileFrameSamples = 0;
let mobileFrameTime = 0;
let mobileQualityReduced = false;

function adaptMobileQuality(dt) {
  if (!MOBILE_DEVICE || !renderer || mobileQualityReduced) return;
  mobileFrameSamples++;
  mobileFrameTime += dt;
  if (mobileFrameSamples < 90) return;

  const avg = mobileFrameTime / mobileFrameSamples;
  if (avg > 0.028 && renderer.getPixelRatio() > 0.9) {
    mobileQualityReduced = true;
    renderer.setPixelRatio(0.9);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (blackHole?.userData?.particles?.material?.uniforms?.uPixelRatio) {
      blackHole.userData.particles.material.uniforms.uPixelRatio.value = 0.9;
    }
    document.documentElement.dataset.quality = 'lite';
  }
  mobileFrameSamples = 0;
  mobileFrameTime = 0;
}

function renderCommon(activeCamera, now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  adaptMobileQuality(dt);
  updateGravity(activeCamera, dt);
  updateARStory(now);
  animateRealisticBlackHole(now / 1000, activeCamera);
  publishScreenAnchor(blackHole, activeCamera);
  updateARLabels(activeCamera);
  updateGravityLab(dt, activeCamera);
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
  if (visitorExperience === 'lab') {
    // Smooth user-controlled orbit: the lab starts from a curated view,
    // then the visitor can rotate and zoom without interrupting the experiment.
    const camDt = Math.min(0.05, Math.max(0.001, (now - labCameraLastFrame) / 1000 || 0.016));
    labCameraLastFrame = now;
    const ease = 1 - Math.exp(-10.5 * camDt);

    simOrbit.theta += (labOrbit.theta - simOrbit.theta) * ease;
    simOrbit.phi += (labOrbit.phi - simOrbit.phi) * ease;
    simOrbit.radius += (labOrbit.radius - simOrbit.radius) * ease;
    simOrbit.target.lerp(labOrbit.target, ease);
  } else if (cameraCinematicMode === 'orbit') {
    simOrbit.theta += 0.0032;
    simOrbit.phi = 1.25 + Math.sin(now * 0.0006) * 0.15;
    const orbitRadius = (innerHeight > innerWidth && innerWidth <= 700) ? 6.65 : 5.2;
    simOrbit.radius = THREE.MathUtils.lerp(simOrbit.radius, orbitRadius, 0.04);
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
  let touchPinchDist = 0;
  let touchMode = 'none'; // none | rotate | pinch

  const isBlockedTarget = (target) =>
    target?.closest?.('button, .interactive-ui, .topbar, .earth-timeline, .cinema-bar, .dock');

  const markManual = () => {
    cameraCinematicMode = 'manual';
    document.querySelectorAll('.cinema-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.view === 'manual');
    });
  };

  const rotateBy = (deltaX, deltaY) => {
    if (visitorExperience === 'lab') {
      labOrbit.theta -= deltaX * 0.0065;
      labOrbit.phi = THREE.MathUtils.clamp(
        labOrbit.phi - deltaY * 0.0065,
        0.28,
        Math.PI - 0.28
      );
      // Keep theta numerically stable after long exhibit sessions.
      if (Math.abs(labOrbit.theta) > Math.PI * 8) {
        labOrbit.theta %= Math.PI * 2;
        simOrbit.theta %= Math.PI * 2;
      }
    } else {
      simOrbit.theta -= deltaX * 0.007;
      simOrbit.phi = THREE.MathUtils.clamp(
        simOrbit.phi - deltaY * 0.007,
        0.15,
        Math.PI - 0.15
      );
    }
    markManual();
  };

  const zoomBy = (delta) => {
    if (visitorExperience === 'lab') {
      labOrbit.radius = THREE.MathUtils.clamp(
        labOrbit.radius + delta,
        MOBILE_DEVICE ? 3.7 : 3.2,
        10.5
      );
    } else {
      simOrbit.radius = THREE.MathUtils.clamp(simOrbit.radius + delta, 2.0, 9.5);
    }
    markManual();
  };

  // Desktop mouse.
  const onMouseDown = (e) => {
    if (mode !== 'simulator' || isBlockedTarget(e.target)) return;
    simOrbit.isDragging = true;
    simOrbit.previousMousePosition = { x:e.clientX, y:e.clientY };
    markManual();
  };

  const onMouseMove = (e) => {
    if (!simOrbit.isDragging || mode !== 'simulator') return;
    const dx = e.clientX - simOrbit.previousMousePosition.x;
    const dy = e.clientY - simOrbit.previousMousePosition.y;
    rotateBy(dx,dy);
    simOrbit.previousMousePosition = { x:e.clientX, y:e.clientY };
  };

  const onMouseUp = () => {
    simOrbit.isDragging = false;
  };

  const onWheel = (e) => {
    if (mode !== 'simulator' || isBlockedTarget(e.target)) return;
    zoomBy(e.deltaY * (visitorExperience === 'lab' ? 0.0042 : 0.0035));
  };

  // Mobile: one finger rotates; two fingers pinch-zoom.
  const onTouchStart = (e) => {
    if (mode !== 'simulator' || isBlockedTarget(e.target)) return;

    if (e.touches.length >= 2) {
      touchMode = 'pinch';
      simOrbit.isDragging = false;
      touchPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      markManual();
      return;
    }

    if (e.touches.length === 1) {
      touchMode = 'rotate';
      simOrbit.isDragging = true;
      simOrbit.previousMousePosition = {
        x:e.touches[0].clientX,
        y:e.touches[0].clientY
      };
      markManual();
    }
  };

  const onTouchMove = (e) => {
    if (mode !== 'simulator' || isBlockedTarget(e.target)) return;

    if (e.touches.length >= 2) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (touchPinchDist > 0) {
        const diff = touchPinchDist - d;
        zoomBy(diff * 0.010);
      }
      touchPinchDist = d;
      touchMode = 'pinch';
      simOrbit.isDragging = false;
      return;
    }

    if (e.touches.length === 1 && touchMode !== 'pinch') {
      const x=e.touches[0].clientX;
      const y=e.touches[0].clientY;
      const dx=x-simOrbit.previousMousePosition.x;
      const dy=y-simOrbit.previousMousePosition.y;
      rotateBy(dx,dy);
      simOrbit.previousMousePosition={x,y};
      touchMode='rotate';
    }
  };

  const onTouchEnd = (e) => {
    if (e.touches.length === 0) {
      touchMode='none';
      touchPinchDist=0;
      simOrbit.isDragging=false;
    } else if (e.touches.length === 1) {
      touchMode='rotate';
      touchPinchDist=0;
      simOrbit.isDragging=true;
      simOrbit.previousMousePosition={
        x:e.touches[0].clientX,
        y:e.touches[0].clientY
      };
    }
  };

  window.addEventListener('mousedown',onMouseDown);
  window.addEventListener('mousemove',onMouseMove);
  window.addEventListener('mouseup',onMouseUp);
  window.addEventListener('wheel',onWheel,{ passive:true });

  window.addEventListener('touchstart',onTouchStart,{ passive:true });
  window.addEventListener('touchmove',onTouchMove,{ passive:true });
  window.addEventListener('touchend',onTouchEnd,{ passive:true });
  window.addEventListener('touchcancel',onTouchEnd,{ passive:true });
}

function updateSimulatorCamera() {
  const x = simOrbit.target.x + simOrbit.radius * Math.sin(simOrbit.phi) * Math.sin(simOrbit.theta);
  const y = simOrbit.target.y + simOrbit.radius * Math.cos(simOrbit.phi);
  const z = simOrbit.target.z + simOrbit.radius * Math.sin(simOrbit.phi) * Math.cos(simOrbit.theta);
  camera.position.set(x, y, z);
  camera.lookAt(simOrbit.target);
}

function preparePlacementState({ simulator = false } = {}) {
  moving = true;
  placed = false;
  reticleReady = simulator;

  if (blackHole) blackHole.visible = false;
  if (reticle) reticle.visible = false;

  if (placeBtn) {
    placeBtn.hidden = false;
    placeBtn.disabled = !simulator;
    placeBtn.classList.toggle('ready', simulator);
    placeBtn.textContent = 'วางหลุมดำ';
  }
  if (moveBtn) moveBtn.hidden = true;
  if (pulseBtn) pulseBtn.hidden = true;

  const toolsBtn = $('#toolsBtn');
  if (toolsBtn) {
    toolsBtn.hidden = true;
    toolsBtn.classList.remove('active');
    toolsBtn.textContent = 'สำรวจ';
  }
  $('#toolTray')?.classList.remove('active');

  ['#missionBtn','#experimentBtn','#earthSimBtn','#physicsBtn','#infoBtn','#videoBtn','#soundToggleBtn','#cinemaBtn','#jetToggleBtn','#labelToggleBtn']
    .forEach((selector) => {
      const el = $(selector);
      if (el) el.style.display = 'none';
    });

  $('#missionPanel')?.classList.remove('active');
  $('#experimentPanel')?.classList.remove('active');
  $('#physicsPanel')?.classList.remove('active');
  $('#infoDrawer')?.classList.remove('active');
  $('#videoModal')?.classList.remove('active');
  $('#cinemaBar')?.style && ($('#cinemaBar').style.display = 'none');

  clearGravityLab();
  cancelMission(false);
  labelsVisible = false;
  updateARLabels(camera);
  pointerBoost = 0;
}

function startSimulatorMode() {
  mode = 'simulator';
  buildScene();
  intro.style.display = 'none';
  arUI.classList.add('on');
  if (feed) feed.style.display = 'none';
  stream?.getTracks?.().forEach((t) => t.stop());
  stream = null;
  if (simulatorStars) simulatorStars.visible = true;

  // Reset orbit camera to a portrait-safe frame.
  // The old 5.2 radius placed the camera just outside the raymarch volume,
  // making the black hole fill/crop the screen on tall phones.
  const portraitPhone = innerHeight > innerWidth && innerWidth <= 700;
  simOrbit.radius = portraitPhone ? 6.65 : 5.2;
  simOrbit.theta = 0.25;
  simOrbit.phi = 1.25;
  simOrbit.target.set(0, 0.78, 0);

  camera.fov = 62;
  camera.updateProjectionMatrix();

  // Start with an empty scene. The visitor explicitly places the black hole.
  preparePlacementState({ simulator:true });

  // Update simulator camera immediately
  updateSimulatorCamera();

  renderer.setAnimationLoop(renderSimulator);
  if (hint) {
    hint.textContent = 'แตะ “วางหลุมดำ” เพื่อเริ่มการจำลอง';
    hint.style.transition = 'none';
    hint.style.opacity = '1';
  }
  setStatus(visitorExperience === 'lab' ? 'กำลังเตรียมห้องทดลอง' : 'พร้อมวางหลุมดำ', true);

  if (visitorExperience === 'lab') {
    placeBlackHole();
  }
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
  preparePlacementState({ simulator:false });
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
  setStatus('AR · พื้นจริง', true);
  if (hint) hint.textContent = 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ เพื่อหาพื้น';
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
    { dist: 1.6 * rs, title: "🍝 3. แรงไทดัลและ Spaghettification", desc: "ความต่างของแรงโน้มถ่วงระหว่างด้านใกล้และด้านไกลทำให้วัตถุถูกยืดตามแนวเข้าหาหลุมดำ" },
    { dist: 1.3 * rs, title: "🔴 4. Gravitational Redshift", desc: "สำหรับผู้สังเกตที่อยู่ไกล แสงจากวัตถุที่เข้าใกล้ขอบฟ้าเหตุการณ์จะเลื่อนไปทางความถี่ต่ำลงและจางลง" },
    { dist: 1.0 * rs, title: "🕳️ 5. ขอบฟ้าเหตุการณ์ (Event Horizon)", desc: "เมื่อผ่านขอบฟ้าเหตุการณ์แล้ว ไม่มีสัญญาณหรือแสงจากวัตถุนั้นสามารถส่งกลับออกมาถึงผู้สังเกตภายนอกได้" }
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
  
  if (earthSim.radius < 1.6 * rs) {
    const stretch = 1.0 + Math.pow(1.4 * rs / Math.max(earthSim.radius, 0.1), 4.0);
    earthSim.mesh.material.uniforms.stretch.value = Math.min(stretch, 25.0);
  }
  
  if (earthSim.radius < 1.5 * rs) {
    const ratio = Math.max(1.001, earthSim.radius / rs);
    const redshift = 1.0 - Math.sqrt(Math.max(0.001, 1.0 - 1.0 / ratio));
    earthSim.mesh.material.uniforms.redshift.value = Math.min(redshift, 1.0);
  }
  
  if (earthSim.radius < 0.98 * rs) {
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
// Mission Mode · guided exhibit challenges
// -----------------------------------------------------------------------------
const MISSIONS = {
  lensing:{
    order:1,title:'เบนลำแสง',
    steps:[{type:'photon',phase:'tidal',label:'ปล่อยลำแสงให้เข้าใกล้หลุมดำจนถึงช่วง Gravitational Lensing'}],
    result:'แสงเดินทางตามเส้นทางในกาล-อวกาศที่โค้ง จึงเกิดการเบนของแสงและปรากฏการณ์เลนส์ความโน้มถ่วง'
  },
  compare:{
    order:2,title:'เปรียบเทียบสองวิถี',
    steps:[
      {type:'earth',phase:'gravity',label:'ส่งโลกเข้าสู่บริเวณที่วิถีเปลี่ยนอย่างชัดเจน'},
      {type:'comet',phase:'gravity',label:'จากนั้นทดลองดาวหางในบริเวณเดียวกัน'}
    ],
    result:'โลกและดาวหางต่างมีวิถีเปลี่ยนจากสนามแรงโน้มถ่วง แต่แบบจำลองใช้รูปร่าง การหมุน และ trail ต่างกันเพื่อช่วยให้สังเกตผลเชิงคุณภาพได้ง่าย'
  },
  horizon:{
    order:3,title:'ถึงขอบฟ้าเหตุการณ์',
    steps:[{type:'satellite',phase:'horizon',label:'ส่งดาวเทียมไปจนถึง Event Horizon'}],
    result:'ขอบฟ้าเหตุการณ์ไม่ใช่พื้นผิวแข็ง แต่เป็นขอบเขตที่เมื่อผ่านเข้าไปแล้ว ไม่มีสัญญาณหรือแสงสามารถกลับออกมาถึงผู้สังเกตภายนอกได้'
  }
};
const PHASE_RANK={far:0,gravity:1,tidal:2,horizon:3};
let missionState={id:null,step:0,complete:false};
const completedMissions=new Set();

function currentMission(){return missionState.id?MISSIONS[missionState.id]:null;}
function currentMissionStep(){return currentMission()?.steps?.[missionState.step]||null;}

function updateMissionTarget(){
  const step=currentMissionStep();
  document.querySelectorAll('.experiment-object').forEach(btn=>{
    btn.classList.toggle('mission-target',!!step&&btn.dataset.object===step.type);
  });
}

function updateMissionHud(state='MISSION ACTIVE'){
  const mission=currentMission(), step=currentMissionStep(), hud=$('#missionHud');
  if(!mission||missionState.complete)return;
  hud?.classList.add('active'); hud?.classList.remove('complete');
  if($('#missionHudState'))$('#missionHudState').textContent=state;
  if($('#missionHudTitle'))$('#missionHudTitle').textContent=mission.title;
  if($('#missionHudText'))$('#missionHudText').textContent=step?.label||'';
  const done=missionState.step,total=mission.steps.length;
  if($('#missionProgressFill'))$('#missionProgressFill').style.transform='scaleX('+Math.min(1,done/total)+')';
  if($('#missionProgressText'))$('#missionProgressText').textContent=done+' / '+total;
  updateMissionTarget();
}

function openExperimentForMission(){
  $('#missionPanel')?.classList.remove('active');
  $('#missionPanel')?.setAttribute('aria-hidden','true');
  $('#missionBtn')?.classList.remove('active');
  $('#experimentPanel')?.classList.add('active');
  $('#experimentPanel')?.setAttribute('aria-hidden','false');
  $('#experimentBtn')?.classList.add('active');
  $('#physicsPanel')?.classList.remove('active');
  $('#infoDrawer')?.classList.remove('active');
  $('#videoModal')?.classList.remove('active');
}

function startMission(id){
  const mission=MISSIONS[id];
  if(!mission||!placed)return;
  clearGravityLab();
  missionState={id,step:0,complete:false};
  $('#missionResult')?.classList.remove('active');
  $('#missionResult')?.setAttribute('aria-hidden','true');
  openExperimentForMission();
  updateMissionHud();
  experimentUI('MISSION',mission.title,currentMissionStep()?.label||'เริ่มภารกิจ');
  navigator.vibrate?.([18,28,18]);
  resetKioskIdle();
}

function nextMissionId(){
  const ordered=Object.entries(MISSIONS).sort((a,b)=>a[1].order-b[1].order);
  const currentOrder=MISSIONS[missionState.id]?.order||0;
  return ordered.find(([id,m])=>m.order>currentOrder&&!completedMissions.has(id))?.[0]
    ||ordered.find(([id])=>!completedMissions.has(id))?.[0]||null;
}

function completeMission(){
  const mission=currentMission();
  if(!mission||missionState.complete)return;
  missionState.complete=true;
  completedMissions.add(missionState.id);
  $('#missionHud')?.classList.add('active','complete');
  if($('#missionHudState'))$('#missionHudState').textContent='MISSION COMPLETE';
  if($('#missionHudText'))$('#missionHudText').textContent='ภารกิจสำเร็จ';
  if($('#missionProgressFill'))$('#missionProgressFill').style.transform='scaleX(1)';
  if($('#missionProgressText')){
    const t=mission.steps.length; $('#missionProgressText').textContent=t+' / '+t;
  }
  document.querySelectorAll('.mission-card').forEach(card=>{
    const done=completedMissions.has(card.dataset.mission);
    card.classList.toggle('completed',done);
    const i=card.querySelector('i'); if(i)i.textContent=done?'สำเร็จ':'เริ่ม';
  });
  document.querySelectorAll('.experiment-object').forEach(btn=>btn.classList.remove('mission-target'));
  if($('#missionResultTitle'))$('#missionResultTitle').textContent=mission.title+' · สำเร็จ';
  if($('#missionResultText'))$('#missionResultText').textContent=mission.result;
  $('#missionResult')?.classList.add('active');
  $('#missionResult')?.setAttribute('aria-hidden','false');
  const next=nextMissionId(), nextBtn=$('#nextMissionBtn');
  if(nextBtn){nextBtn.hidden=!next; nextBtn.textContent=next?'ภารกิจถัดไป':'ครบทุกภารกิจ';}
  navigator.vibrate?.([28,32,28,32,55]);
  resetKioskIdle();
}

function observeMission(type,phase){
  const mission=currentMission(),step=currentMissionStep();
  if(!mission||!step||missionState.complete||type!==step.type)return;
  if((PHASE_RANK[phase]??-1)<(PHASE_RANK[step.phase]??99))return;
  missionState.step++;
  if(missionState.step>=mission.steps.length){completeMission();return;}
  updateMissionHud('STEP COMPLETE');
  experimentUI('NEXT STEP',mission.title,currentMissionStep()?.label||'ทำขั้นต่อไป');
  navigator.vibrate?.([20,24,20]);
}

function cancelMission(resetResult=true){
  missionState={id:null,step:0,complete:false};
  $('#missionHud')?.classList.remove('active','complete');
  document.querySelectorAll('.experiment-object').forEach(btn=>btn.classList.remove('mission-target'));
  if(resetResult){
    $('#missionResult')?.classList.remove('active');
    $('#missionResult')?.setAttribute('aria-hidden','true');
  }
}

// -----------------------------------------------------------------------------
// Gravity Lab · qualitative object experiments
// -----------------------------------------------------------------------------
const labObjects = [];
let activeExperimentType = null;
let lastExperimentPhase = '';

const EXPERIMENTS = {
  earth: {
    label: 'โลก',
    state: 'TIDAL FORCES',
    intro: 'ความต่างของแรงโน้มถ่วงระหว่างด้านใกล้และด้านไกลจะเพิ่มขึ้นเมื่อเข้าใกล้หลุมดำ',
    color: 0x4f86ff,
    speed: 1.85,
    gravityScale: 1.0,
    tangent: 0.52
  },
  star: {
    label: 'ดาวฤกษ์',
    state: 'STELLAR MATTER',
    intro: 'ดาวฤกษ์ที่เข้าใกล้มากพออาจถูกรบกวนและฉีกด้วยแรงไทดัล โดยพฤติกรรมจริงขึ้นกับมวลและระยะ',
    color: 0xffd58c,
    speed: 1.6,
    gravityScale: 1.05,
    tangent: 0.7
  },
  satellite: {
    label: 'ดาวเทียม',
    state: 'ORBIT INSTABILITY',
    intro: 'เมื่อวงโคจรเปลี่ยนไป ดาวเทียมอาจเร่งความเร็วและเสียเสถียรภาพก่อนเข้าสู่บริเวณแรงไทดัลสูง',
    color: 0xc8d6ee,
    speed: 2.0,
    gravityScale: 1.0,
    tangent: 0.82
  },
  comet: {
    label: 'ดาวหาง',
    state: 'CURVED TRAJECTORY',
    intro: 'วิถีของดาวหางถูกความโน้มถ่วงเบนให้โค้ง และความเร็วจะเพิ่มขึ้นเมื่อเคลื่อนเข้าใกล้',
    color: 0x9ee8ff,
    speed: 2.25,
    gravityScale: 0.92,
    tangent: 0.95
  },
  photon: {
    label: 'ลำแสง',
    state: 'LIGHT BENDING',
    intro: 'แสงเคลื่อนที่ตามเส้นทางในกาล-อวกาศที่โค้ง จึงดูเหมือนวิถีถูกเบนรอบวัตถุมวลมาก',
    color: 0xffffff,
    speed: 4.5,
    gravityScale: 0.34,
    tangent: 1.08
  }
};

const LAB_PHASES = ['far','gravity','tidal','horizon'];
const LAB_PHASE_COPY = {
  far: 'เริ่มจากระยะไกล',
  gravity: 'สนามแรงโน้มถ่วงทำให้วิถีเปลี่ยน',
  tidal: 'ผลใกล้หลุมดำชัดขึ้น',
  horizon: 'ถึงขอบฟ้าเหตุการณ์'
};

function updateLabPhaseUI(phase, item = null) {
  const activeIndex = Math.max(0, LAB_PHASES.indexOf(phase));
  document.querySelectorAll('.lab-stage').forEach((el) => {
    const idx = LAB_PHASES.indexOf(el.dataset.labPhase);
    el.classList.toggle('active', idx === activeIndex);
    el.classList.toggle('done', idx < activeIndex);
  });
  const tagPhase = $('#labObjectTagPhase');
  if (tagPhase) tagPhase.textContent = LAB_PHASE_COPY[phase] || '';
  if (item && $('#labObjectTagName')) $('#labObjectTagName').textContent = item.config.label;
}

function updateLabObjectTag(item, activeCamera) {
  const tag = $('#labObjectTag');
  if (!tag || !item?.root) return;
  const p = item.root.position.clone().project(activeCamera);
  if (p.z < -1 || p.z > 1) {
    tag.classList.remove('active');
    return;
  }
  const x = (p.x * .5 + .5) * innerWidth;
  const y = (-p.y * .5 + .5) * innerHeight;
  tag.style.transform = 'translate3d(' + x + 'px,' + (y - 38) + 'px,0) translate(-50%,-100%)';
  tag.classList.add('active');
  tag.setAttribute('aria-hidden','false');
}

function makeGuidedLabCurve(core, activeCamera, type) {
  activeCamera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrixWorld,0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrixWorld,1).normalize();
  const towardCamera = new THREE.Vector3();
  activeCamera.getWorldPosition(towardCamera);
  towardCamera.sub(core).normalize();

  const start = core.clone()
    .add(right.clone().multiplyScalar(-2.55 * baseScale))
    .add(up.clone().multiplyScalar(.55 * baseScale))
    .add(towardCamera.clone().multiplyScalar(.12 * baseScale));

  const c1 = core.clone()
    .add(right.clone().multiplyScalar(-1.65 * baseScale))
    .add(up.clone().multiplyScalar((type === 'photon' ? .92 : .78) * baseScale))
    .add(towardCamera.clone().multiplyScalar(.14 * baseScale));

  const c2 = core.clone()
    .add(right.clone().multiplyScalar(-.52 * baseScale))
    .add(up.clone().multiplyScalar((type === 'photon' ? .58 : .26) * baseScale))
    .add(towardCamera.clone().multiplyScalar(.10 * baseScale));

  const end = core.clone()
    .add(right.clone().multiplyScalar(-.03 * baseScale))
    .add(towardCamera.clone().multiplyScalar(.02 * baseScale));

  return new THREE.CubicBezierCurve3(start,c1,c2,end);
}

function makeFullTrail(color) {
  const positions = new Float32Array(96 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setDrawRange(0,0);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent:true,
    opacity:.82,
    blending:THREE.AdditiveBlending,
    depthTest:false,
    depthWrite:false
  });
  const line = new THREE.Line(geometry,material);
  line.renderOrder = 8;
  return line;
}

function prepareLabVisual(root) {
  root.traverse((child) => {
    if (!child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((mat) => {
      mat.depthTest = false;
      mat.depthWrite = false;
      if ('emissiveIntensity' in mat) mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 0, .7);
    });
    child.renderOrder = 9;
  });
}

function experimentUI(state, title, text, event = false) {
  const stateEl = $('#experimentState');
  const titleEl = $('#experimentTitle');
  const textEl = $('#experimentText');
  const readout = $('#experimentReadout');
  if (stateEl) stateEl.textContent = state;
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
  readout?.classList.toggle('event', event);
}

function disposeObject3D(root) {
  root?.traverse?.((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m?.dispose?.());
    else child.material?.dispose?.();
  });
  root?.parent?.remove(root);
}

function clearGravityLab() {
  while (labObjects.length) {
    const item = labObjects.pop();
    disposeObject3D(item.root);
    item.trail?.geometry?.dispose?.();
    item.trail?.material?.dispose?.();
    item.trail?.parent?.remove(item.trail);
  }
  activeExperimentType = null;
  lastExperimentPhase = '';
  updateLabPhaseUI('far');
  if (visitorExperience === 'lab') setAudioPhase('ambient');
  $('#labObjectTag')?.classList.remove('active');
  $('#labObjectTag')?.setAttribute('aria-hidden','true');
  document.querySelectorAll('.experiment-object').forEach((b) => b.classList.remove('active'));
  experimentUI(
    'READY',
    'เลือกวัตถุเพื่อเริ่มการทดลอง',
    'แบบจำลองนี้ช่วยให้เห็นแนวคิดเชิงคุณภาพ ไม่ได้แทนการคำนวณสัมพัทธภาพทั่วไปแบบเต็มรูปแบบ'
  );
}

function makeEarthLabObject() {
  const group = new THREE.Group();
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 28, 20),
    new THREE.MeshStandardMaterial({ color:0x2d6cff, roughness:.72, metalness:.02, emissive:0x061229 })
  );
  const land = new THREE.Mesh(
    new THREE.SphereGeometry(0.122, 20, 14),
    new THREE.MeshBasicMaterial({ color:0x65b65b, transparent:true, opacity:.28, wireframe:true })
  );
  group.add(globe, land);
  return group;
}

function makeStarLabObject() {
  const group = new THREE.Group();
  const star = new THREE.Mesh(
    new THREE.SphereGeometry(0.115, 24, 18),
    new THREE.MeshBasicMaterial({ color:0xffd48b })
  );
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 20, 14),
    new THREE.MeshBasicMaterial({ color:0xffa75d, transparent:true, opacity:.13, blending:THREE.AdditiveBlending, depthWrite:false })
  );
  group.add(star, halo);
  group.userData.glow = halo;
  return group;
}

function makeSatelliteLabObject() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(.13,.09,.09),
    new THREE.MeshStandardMaterial({ color:0xcbd5e8, metalness:.72, roughness:.28 })
  );
  const panelMat = new THREE.MeshBasicMaterial({ color:0x315fa8, side:THREE.DoubleSide });
  const left = new THREE.Mesh(new THREE.BoxGeometry(.20,.008,.08), panelMat);
  const right = left.clone();
  left.position.x = -.17;
  right.position.x = .17;
  group.add(body,left,right);
  return group;
}

function makeCometLabObject() {
  const group = new THREE.Group();
  const nucleus = new THREE.Mesh(
    new THREE.IcosahedronGeometry(.075,1),
    new THREE.MeshStandardMaterial({ color:0xb7d6e2, roughness:.9, emissive:0x0a1820 })
  );
  const coma = new THREE.Mesh(
    new THREE.SphereGeometry(.11,16,12),
    new THREE.MeshBasicMaterial({ color:0x9ee8ff, transparent:true, opacity:.12, blending:THREE.AdditiveBlending, depthWrite:false })
  );
  group.add(nucleus,coma);
  return group;
}

function makePhotonLabObject() {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(.035,16,12),
    new THREE.MeshBasicMaterial({ color:0xffffff })
  );
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(.07,12,8),
    new THREE.MeshBasicMaterial({ color:0xb9e9ff, transparent:true, opacity:.22, blending:THREE.AdditiveBlending, depthWrite:false })
  );
  group.add(core,halo);
  return group;
}

function makeLabRoot(type) {
  if (type === 'earth') return makeEarthLabObject();
  if (type === 'star') return makeStarLabObject();
  if (type === 'satellite') return makeSatelliteLabObject();
  if (type === 'comet') return makeCometLabObject();
  return makePhotonLabObject();
}

function makeTrail(color) {
  const positions = new Float32Array(48 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geometry.setDrawRange(0,0);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent:true,
    opacity:.56,
    blending:THREE.AdditiveBlending,
    depthWrite:false
  });
  return new THREE.Line(geometry,material);
}

function launchGravityLab(type) {
  if (!placed || !blackHole || !camera || !EXPERIMENTS[type]) return;
  clearGravityLab();
  activeExperimentType = type;

  const config = EXPERIMENTS[type];
  const root = makeLabRoot(type);
  const visualScale = type === 'photon' ? 2.0 : type === 'satellite' ? 2.2 : 2.45;
  root.scale.setScalar(baseScale * visualScale);
  prepareLabVisual(root);

  const core = new THREE.Vector3();
  blackHole.userData.core.getWorldPosition(core);
  const curve = makeGuidedLabCurve(core,camera,type);
  root.position.copy(curve.getPoint(0));

  scene.add(root);

  // Every experiment gets a bright trajectory, not only comet/photon.
  const trail = makeFullTrail(config.color);
  scene.add(trail);

  const duration = type === 'photon' ? 9.5 : 12.0;
  const item = {
    type,
    config,
    root,
    life:0,
    duration,
    curve,
    trail,
    trailPoints:[],
    baseSize:baseScale * visualScale,
    phase:'far',
    horizonDuckDone:false
  };
  labObjects.push(item);

  document.querySelectorAll('.experiment-object').forEach((b) => {
    b.classList.toggle('active', b.dataset.object === type);
  });

  updateLabPhaseUI('far',item);
  setAudioPhase('far');
  experimentUI(
    '1 / 4 · START',
    config.label + ' เริ่มจากระยะไกล',
    'ดูวัตถุและเส้นวิถีสีสว่าง แล้วติดตามทั้ง 4 ช่วงด้านบน'
  );
  navigator.vibrate?.(18);
  resetKioskIdle();
}

function updateLabTrail(item) {
  if (!item.trail) return;
  item.trailPoints.unshift(item.root.position.clone());
  if (item.trailPoints.length > 96) item.trailPoints.pop();

  const attr = item.trail.geometry.getAttribute('position');
  for (let i=0;i<item.trailPoints.length;i++) {
    const p = item.trailPoints[i];
    attr.setXYZ(i,p.x,p.y,p.z);
  }
  attr.needsUpdate = true;
  item.trail.geometry.setDrawRange(0,item.trailPoints.length);
}

function updateExperimentNarrative(item, progress) {
  if (item !== labObjects[0]) return;

  let phase = 'far';
  let state = '1 / 4 · START';
  let title = item.config.label + ' เริ่มจากระยะไกล';
  let text = 'ที่ระยะไกล วัตถุยังไม่ได้ตกตรงเข้าหาหลุมดำทันที แต่เส้นทางจะค่อย ๆ เปลี่ยนเมื่อสนามแรงขึ้น';
  let event = false;

  if (progress >= .25) {
    phase = 'gravity';
    state = '2 / 4 · GRAVITY';
    title = 'วิถีเริ่มโค้งเข้าหาหลุมดำ';
    text = item.type === 'photon'
      ? 'แสงเดินทางตามเส้นทางในกาล-อวกาศที่โค้ง จึงเห็นเส้นแสงเบนจากแนวเดิม'
      : 'สนามแรงโน้มถ่วงที่เข้มขึ้นทำให้ความเร็วและทิศทางของวัตถุเปลี่ยนชัดเจน';
  }

  if (progress >= .58) {
    phase = 'tidal';
    state = item.type === 'photon' ? '3 / 4 · LIGHT BENDING' : '3 / 4 · TIDAL EFFECT';
    event = true;

    if (item.type === 'earth' || item.type === 'star' || item.type === 'satellite') {
      title = 'วัตถุเริ่มถูกยืด';
      text = 'ด้านที่ใกล้หลุมดำถูกดึงแรงกว่าด้านไกล จึงเห็นการยืดตัวตามแนวเข้าสู่หลุมดำ';
    } else if (item.type === 'comet') {
      title = 'วิถีดาวหางโค้งแรงขึ้น';
      text = 'เส้นทางสว่างช่วยให้เห็นการเบนและการเร่งของดาวหางอย่างชัดเจน';
    } else {
      title = 'แสงถูกเบนอย่างรุนแรง';
      text = 'ใกล้หลุมดำ เส้นทางแสงโค้งมากขึ้นจากความโค้งของกาล-อวกาศ';
    }
  }

  if (progress >= .86) {
    phase = 'horizon';
    state = '4 / 4 · EVENT HORIZON';
    title = 'ถึงขอบฟ้าเหตุการณ์';
    text = item.type === 'photon'
      ? 'เมื่อเส้นทางแสงผ่านขอบฟ้าเหตุการณ์แล้ว แสงนั้นไม่สามารถกลับออกมาถึงผู้สังเกตภายนอกได้'
      : 'เมื่อวัตถุผ่านขอบฟ้าเหตุการณ์แล้ว ไม่มีสัญญาณจากวัตถุนั้นกลับออกมาถึงผู้สังเกตภายนอกได้';
    event = true;
  }

  if (phase !== lastExperimentPhase) {
    lastExperimentPhase = phase;
    item.phase = phase;
    updateLabPhaseUI(phase,item);
    setAudioPhase(phase);
    experimentUI(state,title,text,event);
    navigator.vibrate?.(phase === 'horizon' ? [28,32,48] : 16);
  }
}

function updateGravityLab(dt, activeCamera) {
  if (!blackHole || !blackHole.visible || !labObjects.length) return;

  const core = new THREE.Vector3();
  blackHole.userData.core.getWorldPosition(core);

  for (let i=labObjects.length-1;i>=0;i--) {
    const item = labObjects[i];
    item.life += dt;

    // Guided timing makes the cause/effect legible to visitors.
    // Smoothstep-like easing slows the first half and gives time to read.
    const raw = THREE.MathUtils.clamp(item.life / item.duration,0,1);
    const progress = raw * raw * (3 - 2 * raw);
    if (progress >= .81 && !item.horizonDuckDone) {
      item.horizonDuckDone = true;
      prepareHorizonSilence(.66);
    }
    const point = item.curve.getPoint(progress);
    const ahead = item.curve.getPoint(Math.min(1,progress + .012));
    item.root.position.copy(point);

    const tangent = ahead.clone().sub(point).normalize();
    if (tangent.lengthSq() > .0001) {
      item.root.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),tangent);
    }

    updateLabTrail(item);
    updateExperimentNarrative(item,progress);
    updateLabObjectTag(item,activeCamera);

    // Visual teaching effects, intentionally exaggerated for readability.
    const tidal = THREE.MathUtils.clamp((progress - .58) / .28,0,1);
    if (item.type === 'earth' || item.type === 'star') {
      const stretch = THREE.MathUtils.lerp(1,4.2,tidal);
      item.root.scale.set(
        item.baseSize / Math.sqrt(stretch),
        item.baseSize * stretch,
        item.baseSize / Math.sqrt(stretch)
      );
    } else if (item.type === 'satellite') {
      item.root.rotation.x += dt * (1.2 + tidal * 7);
      item.root.rotation.z += dt * (1 + tidal * 5);
      item.root.scale.set(item.baseSize,item.baseSize * (1 + tidal * 1.8),item.baseSize);
    } else if (item.type === 'comet') {
      item.root.rotation.y += dt * 2.2;
      item.root.scale.setScalar(item.baseSize * (1 + tidal * .22));
    } else if (item.type === 'photon') {
      item.root.scale.setScalar(item.baseSize * (.94 + Math.sin(item.life*18)*.08));
    }

    if (progress > .78 && item.type !== 'photon') {
      item.root.traverse((child) => {
        if (child.material?.color) {
          child.material.color.lerp(new THREE.Color(0xb72e1d),dt * 1.1);
        }
      });
    }

    // Fade only after the Event Horizon stage has been visible.
    if (progress >= .96) {
      item.root.traverse((child) => {
        if (!child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          m.transparent = true;
          m.opacity = Math.max(0,(1-progress)/.04);
        });
      });
    }

    if (raw >= 1) {
      disposeObject3D(item.root);
      item.trail?.geometry?.dispose?.();
      item.trail?.material?.dispose?.();
      item.trail?.parent?.remove(item.trail);
      labObjects.splice(i,1);
      $('#labObjectTag')?.classList.remove('active');

      if (!labObjects.length) {
        setTimeout(() => {
          if (!labObjects.length && activeExperimentType) {
            experimentUI(
              'COMPLETE',
              'เห็นครบทั้ง 4 ช่วงแล้ว',
              'เลือกวัตถุเดิมเพื่อดูซ้ำ หรือเลือกวัตถุชนิดอื่นเพื่อเปรียบเทียบ'
            );
          }
        },450);
      }
    }
  }
}

async function startFallback() {
  mode = 'fallback';
  preparePlacementState({ simulator:false });

  if (simulatorStars) simulatorStars.visible = false;

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  feed.srcObject = stream;
  feed.style.display = 'block';
  await feed.play().catch(() => {});

  // Camera AR fallback intentionally avoids gyro tracking.
  // The rear-camera image is real; the black hole stays visually stable
  // in screen space instead of wobbling from noisy mobile sensors.
  gyro.live = false;
  camera.position.set(0, EYE_HEIGHT, 0);
  camera.rotation.set(-0.48, 0, 0);
  camera.fov = 62;
  camera.updateProjectionMatrix();

  renderer.setAnimationLoop(renderFallback);
  setStatus('AR · กล้องจริง', true);

  if (hint) {
    hint.style.transition = 'none';
    hint.style.opacity = '1';
    hint.textContent = 'เล็งตำแหน่งกลางภาพ แล้วแตะ “วางหลุมดำ”';
  }
}

async function launch() {
  if (launching) return;
  launching = true;
  setVisitorExperience('ar');
  audio = initAudio();
  enableExperienceAudio();
  setAudioPhase('ambient');
  ensureCinematicLayer();

  const launchLabel = startBtn?.querySelector('i');
  if (startBtn) startBtn.disabled = true;
  if (launchLabel) launchLabel.textContent = 'กำลังเปิดกล้อง...';

  mode = 'warp';
  intro.style.opacity = '0';
  intro.style.transition = 'opacity 0.55s ease';

  const flash = document.createElement('div');
  flash.className = 'flash-overlay active';
  document.body.appendChild(flash);
  setTimeout(() => flash.classList.remove('active'), 550);

  setTimeout(async () => {
    try {
      intro.style.display = 'none';
      arUI.classList.add('on');

      camera.fov = 62;
      camera.updateProjectionMatrix();

      // AR choice always remains an AR/camera experience.
      // Prefer WebXR hit-test when supported; otherwise use the real rear
      // camera as background with a stable camera-AR placement layer.
      setStatus('กำลังเปิด AR', false);
      const session = await requestXRSession();

      if (session) {
        if (feed) feed.style.display = 'none';
        await startXR(session);
      } else if (navigator.mediaDevices?.getUserMedia) {
        await startFallback();
      } else {
        throw new Error('Rear camera is not available in this browser');
      }
    } catch (e) {
      console.warn('[AR Black Hole] Camera mode failed:', e);
      stream?.getTracks?.().forEach((t) => t.stop());
      if (feed) feed.style.display = 'none';
      showError(
        'เปิดกล้องจริงไม่สำเร็จ',
        'โปรดอนุญาตสิทธิ์กล้องหลัง หรือเลือก “แบบจำลอง 3D” เพื่อใช้งานโดยไม่ใช้กล้อง',
        true
      );
    } finally {
      launching = false;
    }
  }, 650);
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
      setVisitorExperience('lab');
      audio = initAudio();
      enableExperienceAudio();
      setAudioPhase('ambient');
      ensureCinematicLayer();

      const simLabel = simIntroBtn.querySelector('i');
      simIntroBtn.disabled = true;
      if (simLabel) simLabel.textContent = 'กำลังเปิดแบบจำลอง...';

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

  const toolsBtn = $('#toolsBtn');
  const toolTray = $('#toolTray');
  if (toolsBtn && toolTray) {
    toolsBtn.addEventListener('click', () => {
      const open = !toolTray.classList.contains('active');
      toolTray.classList.toggle('active', open);
      toolsBtn.classList.toggle('active', open);
      toolsBtn.textContent = open ? 'ปิดเครื่องมือ' : 'สำรวจ';
      resetKioskIdle();
    });
  }

  // Earth Sim
  const earthSimBtn = $('#earthSimBtn');
  if (earthSimBtn) {
    earthSimBtn.addEventListener('click', startEarthSimulation);
  }

  // Mission Mode
  const missionBtn=$('#missionBtn');
  const missionPanel=$('#missionPanel');
  const closeMissionBtn=$('#closeMissionBtn');
  const cancelMissionBtn=$('#cancelMissionBtn');
  const missionContinueBtn=$('#missionContinueBtn');
  const nextMissionBtn=$('#nextMissionBtn');

  if(missionBtn&&missionPanel){
    missionBtn.addEventListener('click',()=>{
      const open=!missionPanel.classList.contains('active');
      missionPanel.classList.toggle('active',open);
      missionPanel.setAttribute('aria-hidden',open?'false':'true');
      missionBtn.classList.toggle('active',open);
      $('#experimentPanel')?.classList.remove('active');
      $('#experimentPanel')?.setAttribute('aria-hidden','true');
      $('#experimentBtn')?.classList.remove('active');
      $('#physicsPanel')?.classList.remove('active');
      $('#infoDrawer')?.classList.remove('active');
      $('#videoModal')?.classList.remove('active');
      resetKioskIdle();
    });
  }
  closeMissionBtn?.addEventListener('click',()=>{
    missionPanel?.classList.remove('active');
    missionPanel?.setAttribute('aria-hidden','true');
    missionBtn?.classList.remove('active');
  });
  cancelMissionBtn?.addEventListener('click',()=>{cancelMission();clearGravityLab();});
  missionContinueBtn?.addEventListener('click',()=>{
    $('#missionResult')?.classList.remove('active');
    $('#missionResult')?.setAttribute('aria-hidden','true');
    $('#missionHud')?.classList.remove('active','complete');
    missionState={id:null,step:0,complete:false};
  });
  nextMissionBtn?.addEventListener('click',()=>{
    const next=nextMissionId();
    $('#missionResult')?.classList.remove('active');
    $('#missionResult')?.setAttribute('aria-hidden','true');
    if(next)startMission(next);
  });
  document.querySelectorAll('.mission-card').forEach(card=>{
    card.addEventListener('click',()=>startMission(card.dataset.mission));
  });

  // Gravity Lab
  const experimentBtn = $('#experimentBtn');
  const experimentPanel = $('#experimentPanel');
  const closeExperimentBtn = $('#closeExperimentBtn');
  const clearExperimentBtn = $('#clearExperimentBtn');

  if (experimentBtn && experimentPanel) {
    experimentBtn.addEventListener('click', () => {
      const open = !experimentPanel.classList.contains('active');
      experimentPanel.classList.toggle('active',open);
      experimentPanel.setAttribute('aria-hidden',open ? 'false' : 'true');
      experimentBtn.classList.toggle('active',open);
      $('#missionPanel')?.classList.remove('active');
      $('#missionPanel')?.setAttribute('aria-hidden','true');
      $('#missionBtn')?.classList.remove('active');
      $('#physicsPanel')?.classList.remove('active');
      $('#infoDrawer')?.classList.remove('active');
      $('#videoModal')?.classList.remove('active');
      resetKioskIdle();
    });
  }

  closeExperimentBtn?.addEventListener('click', () => {
    if (visitorExperience === 'lab') {
      clearGravityLab();
      return;
    }
    experimentPanel?.classList.remove('active');
    experimentPanel?.setAttribute('aria-hidden','true');
    experimentBtn?.classList.remove('active');
  });

  clearExperimentBtn?.addEventListener('click', clearGravityLab);
  $('#resetLabViewBtn')?.addEventListener('click', () => {
    resetLabCamera(false);
    if (hint) {
      hint.style.opacity = '1';
      hint.textContent = 'ลากเพื่อหมุน · หนีบสองนิ้วเพื่อซูม';
      setTimeout(() => {
        if (visitorExperience === 'lab' && hint) hint.style.opacity = '.72';
      }, 1800);
    }
  });

  document.querySelectorAll('.experiment-object').forEach((button) => {
    button.addEventListener('click', () => launchGravityLab(button.dataset.object));
  });

  // Snapshot + native share functionality
  const snapshotBtn = $('#snapshotBtn');
  const flashOverlay = $('#flashOverlay');
  if (snapshotBtn) {
    snapshotBtn.addEventListener('click', async () => {
      const topbar = document.querySelector('.topbar');
      const labels = document.getElementById('arLabels');
      const tray = document.getElementById('toolTray');
      const dock = document.querySelector('.dock');
      const old = {
        topbar: topbar?.style.display || '',
        labels: labels?.style.display || '',
        tray: tray?.style.display || '',
        dock: dock?.style.display || ''
      };

      if (topbar) topbar.style.display = 'none';
      if (labels) labels.style.display = 'none';
      if (tray) tray.style.display = 'none';
      if (dock) dock.style.display = 'none';

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      try {
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.floor(innerWidth * Math.min(devicePixelRatio || 1, 2)));
        out.height = Math.max(1, Math.floor(innerHeight * Math.min(devicePixelRatio || 1, 2)));
        const ctx = out.getContext('2d');
        const scale = out.width / innerWidth;
        ctx.scale(scale, scale);

        if (mode === 'fallback' && feed?.videoWidth) {
          const vw = feed.videoWidth, vh = feed.videoHeight;
          const cover = Math.max(innerWidth / vw, innerHeight / vh);
          const dw = vw * cover, dh = vh * cover;
          ctx.drawImage(feed, (innerWidth - dw) / 2, (innerHeight - dh) / 2, dw, dh);
        } else {
          ctx.fillStyle = '#02040a';
          ctx.fillRect(0, 0, innerWidth, innerHeight);
        }

        ctx.drawImage(renderer.domElement, 0, 0, innerWidth, innerHeight);

        const grad = ctx.createLinearGradient(0, innerHeight - 100, 0, innerHeight);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,.58)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, innerHeight - 100, innerWidth, 100);
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.font = '600 11px system-ui,sans-serif';
        ctx.fillText('BLACK HOLE · NAKHON SAWAN SCIENCE CENTER', 18, innerHeight - 18);

        const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png', .96));
        if (!blob) throw new Error('capture failed');

        const file = new File([blob], 'black-hole-experience.png', { type:'image/png' });
        if (navigator.share && navigator.canShare?.({ files:[file] })) {
          await navigator.share({
            files:[file],
            title:'Black Hole Experience',
            text:'Black Hole · Nakhon Sawan Science Center'
          }).catch(() => {});
        } else {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.download = 'black-hole-experience.png';
          link.href = url;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      } finally {
        if (topbar) topbar.style.display = old.topbar;
        if (labels) labels.style.display = old.labels;
        if (tray) tray.style.display = old.tray;
        if (dock) dock.style.display = old.dock;
        if (flashOverlay) {
          flashOverlay.classList.add('active');
          setTimeout(() => flashOverlay.classList.remove('active'), 70);
        }
        resetKioskIdle();
      }
    });
  }

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
  $('#experienceSoundBtn')?.addEventListener('click', toggleAudio);
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
      $('#experimentPanel')?.classList.remove('active');
      $('#experimentBtn')?.classList.remove('active');
      $('#missionPanel')?.classList.remove('active');
      $('#missionPanel')?.setAttribute('aria-hidden','true');
      $('#missionBtn')?.classList.remove('active');
    });
  }

  if (infoBtn && infoDrawer) {
    infoBtn.addEventListener('click', () => {
      infoDrawer.classList.toggle('active');
      if (physicsPanel) physicsPanel.classList.remove('active');
      if (videoModal) videoModal.classList.remove('active');
      $('#experimentPanel')?.classList.remove('active');
      $('#experimentBtn')?.classList.remove('active');
      $('#missionPanel')?.classList.remove('active');
      $('#missionPanel')?.setAttribute('aria-hidden','true');
      $('#missionBtn')?.classList.remove('active');
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
    $('#experimentPanel')?.classList.remove('active');
    $('#experimentBtn')?.classList.remove('active');
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
  clearGravityLab();
  stream?.getTracks().forEach((t) => t.stop());
  if (audio?.ctx && audio.ctx.state !== 'closed') audio.ctx.close().catch(() => {});
});

// Initialize UI binders on page load
setupInteractiveUI();
setVisitorExperience('intro');
startIntroMode();

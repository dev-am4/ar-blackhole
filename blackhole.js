import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

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

const DEBUG = new URLSearchParams(location.search).has('debug');
if (DEBUG) hud.classList.add('on');

let renderer, scene, camera, reticle, blackHole;
let xrSession = null;
let xrHitSource = null;
let stream = null;
let mode = 'boot';
let moving = true;
let placed = false;
let reticleReady = false;
let launching = false;
let scale = 1;
let pinchStart = 0;
let pinchScale = 1;
let pointerBoost = 0;
let proximity = 0;
let gravity = 0;
let gravityTarget = 0;
let lastFrame = performance.now();
let nearLatch = false;
let audio = null;

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
  statusText.textContent = text;
  statusDot.classList.toggle('ready', ready);
}

function showError(title, text) {
  messageTitle.textContent = title;
  messageText.textContent = text;
  message.classList.add('on');
}

function requestOrientation() {
  if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
    return DeviceOrientationEvent.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted');
}

function initAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const master = ctx.createGain();
    const low = ctx.createOscillator();
    const lowGain = ctx.createGain();
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();

    master.gain.value = 0.0001;
    low.type = 'sine';
    low.frequency.value = 58;
    lowGain.gain.value = 0.7;
    sub.type = 'triangle';
    sub.frequency.value = 29;
    subGain.gain.value = 0.35;

    low.connect(lowGain).connect(master);
    sub.connect(subGain).connect(master);
    master.connect(ctx.destination);
    low.start();
    sub.start();
    ctx.resume().catch(() => {});
    return { ctx, master, low, sub };
  } catch {
    return null;
  }
}

function updateAudio(strength) {
  if (!audio) return;
  const t = audio.ctx.currentTime;
  const vol = placed ? 0.008 + strength * 0.032 : 0.0001;
  audio.master.gain.setTargetAtTime(vol, t, 0.08);
  audio.low.frequency.setTargetAtTime(52 + strength * 24, t, 0.08);
  audio.sub.frequency.setTargetAtTime(26 + strength * 11, t, 0.08);
}

function makeHaloTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 60, size / 2, size / 2, 244);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.30, 'rgba(255,246,216,0)');
  g.addColorStop(0.39, 'rgba(255,236,180,.92)');
  g.addColorStop(0.45, 'rgba(255,139,61,.52)');
  g.addColorStop(0.58, 'rgba(112,104,255,.20)');
  g.addColorStop(0.78, 'rgba(36,96,255,.06)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function createAccretionDisk() {
  const geo = new THREE.RingGeometry(0.42, 1.58, 192, 3);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 },
      uOpacity: { value: 1 }
    },
    vertexShader: `
      varying vec2 vPos;
      void main(){
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vPos;
      uniform float uTime;
      uniform float uGravity;
      uniform float uOpacity;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      void main(){
        float r = length(vPos);
        float a = atan(vPos.y,vPos.x);
        float ring = smoothstep(1.58,1.26,r) * smoothstep(.42,.53,r);
        float streak = .52 + .48*sin(a*26.0 - uTime*(2.0+uGravity*4.8) + r*31.0);
        float streak2 = .52 + .48*sin(a*11.0 + uTime*(1.2+uGravity*3.2) - r*19.0);
        float grain = hash(floor(vPos*95.0) + floor(uTime*8.0));
        float innerHeat = 1.0 - smoothstep(.50,1.45,r);
        vec3 hot = vec3(1.0,.95,.80);
        vec3 amber = vec3(1.0,.30,.045);
        vec3 violet = vec3(.23,.17,1.0);
        vec3 col = mix(amber,hot,innerHeat);
        col = mix(col,violet,smoothstep(1.0,1.58,r)*.38);
        float alpha = ring * (.24 + streak*.55 + streak2*.20) * (.74 + grain*.26);
        alpha *= uOpacity * (1.0 + uGravity*.58);
        gl_FragColor = vec4(col*alpha*1.35, alpha);
      }
    `
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.y = 0.34;
  return mesh;
}

function createParticles(count = 900) {
  const geo = new THREE.BufferGeometry();
  const angle = new Float32Array(count);
  const radius = new Float32Array(count);
  const height = new Float32Array(count);
  const speed = new Float32Array(count);
  const seed = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    angle[i] = Math.random() * Math.PI * 2;
    radius[i] = 0.54 + Math.pow(Math.random(), 0.72) * 1.7;
    height[i] = (Math.random() - 0.5) * (0.06 + radius[i] * 0.09);
    speed[i] = 0.35 + Math.random() * 1.8;
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
      uPixelRatio: { value: Math.min(devicePixelRatio, 2) }
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
        float t = uTime * aSpeed * (1.0 + uGravity*4.2);
        float phase = fract(aSeed + uTime*(.025 + aSpeed*.005)*max(uGravity,.16));
        float plunge = pow(phase, 10.0) * uGravity;
        float r = mix(aRadius, .26, plunge);
        float a = aAngle + t + r*1.7;
        float y = aHeight * (1.0-plunge) + sin(t*1.7+aSeed*9.0)*.018;
        vec3 p = vec3(cos(a)*r, y, sin(a)*r);
        vec4 mv = modelViewMatrix * vec4(p,1.0);
        gl_Position = projectionMatrix * mv;
        float size = mix(2.0,5.5,uGravity) * (1.0 + (1.0-r/aRadius)*1.4);
        gl_PointSize = size * uPixelRatio * (1.5 / max(.4,-mv.z));
        vHeat = 1.0 - smoothstep(.35,2.2,r);
        vAlpha = .34 + aSeed*.64;
      }
    `,
    fragmentShader: `
      precision mediump float;
      varying float vHeat;
      varying float vAlpha;
      void main(){
        vec2 q = gl_PointCoord-.5;
        float d = length(q);
        if(d>.5) discard;
        float a = smoothstep(.5,0.0,d)*vAlpha;
        vec3 outer = vec3(.40,.35,1.0);
        vec3 inner = vec3(1.0,.72,.30);
        vec3 col = mix(outer,inner,vHeat);
        gl_FragColor = vec4(col*a,a);
      }
    `
  });

  return new THREE.Points(geo, mat);
}

function makeReticle() {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.13, 0.165, 72),
    new THREE.MeshBasicMaterial({ color: 0x8ddcff, transparent: true, opacity: 0.92, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.025, 0.034, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd28f, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
  );
  inner.rotation.x = -Math.PI / 2;
  group.add(inner);
  group.visible = false;
  return group;
}

function buildBlackHole() {
  const root = new THREE.Group();
  root.visible = false;

  const coreMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.34, 72, 48), coreMat);
  core.position.y = 0.78;
  root.add(core);

  const haloTexture = makeHaloTexture();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.92
  }));
  halo.position.y = 0.78;
  halo.scale.set(2.7, 2.7, 1);
  root.add(halo);

  const disk = createAccretionDisk();
  disk.position.y = 0.78;
  disk.rotation.z = 0.06;
  root.add(disk);

  const particles = createParticles();
  particles.position.y = 0.78;
  root.add(particles);

  const lens = new THREE.Mesh(
    new THREE.TorusGeometry(0.48, 0.012, 12, 144),
    new THREE.MeshBasicMaterial({ color: 0xffe4a8, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  lens.position.y = 0.78;
  root.add(lens);

  root.userData = { core, halo, disk, particles, lens };
  return root;
}

function buildScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 100);
  camera.position.set(0, EYE_HEIGHT, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.className = 'gl';
  document.body.appendChild(renderer.domElement);

  reticle = makeReticle();
  scene.add(reticle);
  blackHole = buildBlackHole();
  scene.add(blackHole);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    blackHole.userData.particles.material.uniforms.uPixelRatio.value = Math.min(devicePixelRatio, 2);
  });
}

function updateReady(v) {
  if (v === reticleReady) return;
  reticleReady = v;
  placeBtn.disabled = !v;
  placeBtn.classList.toggle('ready', v);
  arUI.classList.toggle('ready-to-place', v && moving);
  setStatus(v ? 'จับพื้นได้แล้ว' : 'กำลังจับพื้น', v);
  if (moving) {
    hint.textContent = v ? 'พร้อมแล้ว · แตะ “วางหลุมดำ”' : 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ';
  }
}

function placeBlackHole() {
  if (!moving || !reticle.visible) return;
  blackHole.position.copy(reticle.position);
  blackHole.scale.setScalar(scale);
  blackHole.visible = true;
  reticle.visible = false;
  moving = false;
  placed = true;
  placeBtn.hidden = true;
  moveBtn.hidden = false;
  pulseBtn.hidden = false;
  arUI.classList.remove('ready-to-place');
  hint.textContent = mode === 'xr'
    ? 'เดินเข้าใกล้เพื่อเพิ่มแรงโน้มถ่วง · ใช้สองนิ้วย่อ/ขยาย'
    : 'แตะค้างบนจอหรือกด “เร่งแรงดูด” · ใช้สองนิ้วย่อ/ขยาย';
  setStatus('หลุมดำทำงาน', true);
}

function moveBlackHole() {
  moving = true;
  placed = false;
  blackHole.visible = false;
  placeBtn.hidden = false;
  moveBtn.hidden = true;
  pulseBtn.hidden = true;
  pointerBoost = 0;
  updateReady(false);
  hint.textContent = 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ';
}

function pulseGravity() {
  if (!placed) return;
  pointerBoost = 1;
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

  if (mode === 'xr') {
    proximity = THREE.MathUtils.clamp(1 - (distance - 0.62) / 2.35, 0, 1);
    proximity = proximity * proximity * (3 - 2 * proximity);
  } else {
    proximity *= Math.max(0, 1 - dt * 1.8);
  }

  pointerBoost *= Math.max(0, 1 - dt * 0.8);
  gravityTarget = Math.max(0.12, proximity, pointerBoost);
  gravity += (gravityTarget - gravity) * Math.min(1, dt * 4.5);

  const pct = Math.round(gravity * 100);
  meterFill.style.transform = `scaleX(${Math.max(0.04, gravity)})`;
  meterValue.textContent = `${pct}%`;

  if (gravity > 0.78 && !nearLatch) {
    nearLatch = true;
    navigator.vibrate?.([18, 22, 26]);
  }
  if (gravity < 0.55) nearLatch = false;

  updateAudio(gravity);
}

function animateBlackHole(t) {
  if (!blackHole) return;
  const { halo, disk, particles, lens, core } = blackHole.userData;
  disk.material.uniforms.uTime.value = t;
  disk.material.uniforms.uGravity.value = gravity;
  particles.material.uniforms.uTime.value = t;
  particles.material.uniforms.uGravity.value = gravity;

  disk.rotation.z = t * (0.08 + gravity * 0.18);
  disk.rotation.y = Math.sin(t * 0.22) * 0.06;
  halo.material.opacity = 0.62 + gravity * 0.38;
  const haloScale = 2.45 + gravity * 0.62 + Math.sin(t * 2.4) * 0.035;
  halo.scale.set(haloScale, haloScale, 1);
  lens.material.opacity = 0.35 + gravity * 0.58;
  lens.scale.setScalar(1 + gravity * 0.12);
  lens.rotation.z = -t * (0.18 + gravity * 0.42);
  core.scale.setScalar(1 + gravity * 0.055 + Math.sin(t * 3.0) * 0.006);
}

function renderCommon(activeCamera, now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  updateGravity(activeCamera, dt);
  animateBlackHole(now / 1000);
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

async function startXR() {
  mode = 'xr';
  renderer.xr.enabled = true;
  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: arUI }
  });
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
  setStatus('WebXR พร้อม', false);
  hint.textContent = 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ';
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
    addEventListener('deviceorientation', (e) => {
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
  hint.textContent = gyro.live
    ? 'เล็งกล้องลงพื้นที่โล่ง แล้วขยับช้า ๆ'
    : 'เล็งกล้องลงพื้น · เครื่องนี้ไม่อนุญาตเซ็นเซอร์หมุน';
}

async function launch() {
  if (launching) return;
  launching = true;
  audio = initAudio();
  const orientationPromise = requestOrientation();
  startBtn.disabled = true;
  startBtn.textContent = 'กำลังเปิดกล้อง…';

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('เบราว์เซอร์นี้ไม่รองรับการเข้าถึงกล้อง');
    }

    buildScene();
    intro.style.display = 'none';
    arUI.classList.add('on');
    setStatus('กำลังตรวจ AR', false);

    const xrOK = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
    if (xrOK) {
      await startXR();
    } else {
      const orientation = await orientationPromise;
      await startFallback(orientation);
    }
  } catch (e) {
    console.error(e);
    showError('เปิด AR ไม่สำเร็จ', `${e.message || e} — กรุณาเปิดผ่าน Safari หรือ Chrome และอนุญาตใช้กล้อง`);
  }
}

function updateHud(activeCamera) {
  if (!DEBUG || !blackHole) return;
  activeCamera.getWorldPosition(tmpCamPos);
  blackHole.userData.core.getWorldPosition(tmpCorePos);
  hud.textContent = [
    `mode ${mode}`,
    `placed ${placed} moving ${moving}`,
    `reticle ${reticle?.visible}`,
    `gravity ${gravity.toFixed(3)} target ${gravityTarget.toFixed(3)}`,
    `cam ${tmpCamPos.x.toFixed(2)} ${tmpCamPos.y.toFixed(2)} ${tmpCamPos.z.toFixed(2)}`,
    `core ${tmpCorePos.x.toFixed(2)} ${tmpCorePos.y.toFixed(2)} ${tmpCorePos.z.toFixed(2)}`,
    `scale ${scale.toFixed(2)}`
  ].join('\n');
}

startBtn.addEventListener('click', launch);
placeBtn.addEventListener('click', placeBlackHole);
moveBtn.addEventListener('click', moveBlackHole);
pulseBtn.addEventListener('click', pulseGravity);
exitBtn.addEventListener('click', () => location.reload());
$('#retryBtn').addEventListener('click', () => location.reload());

addEventListener('pointerdown', (e) => {
  if (!placed || e.target.closest('button')) return;
  pointerBoost = Math.max(pointerBoost, 0.65);
});
addEventListener('pointermove', (e) => {
  if (!placed || !(e.buttons & 1) || e.target.closest('button')) return;
  pointerBoost = 1;
});
addEventListener('pointerup', () => {
  if (mode !== 'xr') pointerBoost = Math.max(pointerBoost, 0.45);
});

addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && placed) {
    pinchStart = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    pinchScale = scale;
  }
}, { passive: true });

addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && placed && pinchStart) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    scale = THREE.MathUtils.clamp(pinchScale * d / pinchStart, 0.55, 2.5);
    blackHole.scale.setScalar(scale);
  }
}, { passive: true });

addEventListener('touchend', () => { pinchStart = 0; }, { passive: true });

addEventListener('beforeunload', () => {
  stream?.getTracks().forEach((t) => t.stop());
  if (audio?.ctx && audio.ctx.state !== 'closed') audio.ctx.close().catch(() => {});
});

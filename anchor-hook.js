import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

/*
 * Scientific + Cinematic hero black hole.
 *
 * Design goals:
 * - Event Horizon remains deep black, not a glowing portal.
 * - Thin photon ring, asymmetric relativistic beaming, inclined accretion disk.
 * - Gravitationally-lensed far-side arcs above and below the shadow.
 * - Controlled 24 s build -> Event Horizon peak -> reset matching the exhibit story.
 * - Transparent world-space billboard: no video rectangle, no black background asset.
 * - Existing placement, gravity, audio, particles and WOW overlay remain intact.
 * - Screen-space WOW effects are anchored to the actual AR black-hole position.
 */

const originalRender = THREE.WebGLRenderer.prototype.render;
const camQuat = new THREE.Quaternion();
const parentQuat = new THREE.Quaternion();
const coreWorld = new THREE.Vector3();
const ndc = new THREE.Vector3();
let cachedBlackHole = null;
let heroPlane = null;

function buildHeroBlackHole(hole) {
  if (heroPlane || !hole?.userData) return;

  const { core, halo, disk, particles, lens } = hole.userData;

  // Remove the legacy appearance while preserving its transforms and logic.
  if (core) core.visible = false;
  if (halo) halo.visible = false;
  if (disk) disk.visible = false;
  if (lens) lens.visible = false;

  if (particles) {
    particles.visible = true;
    particles.renderOrder = 1;
    // Sparse particles read as orbiting matter. The old 900-point cloud looked game-like.
    particles.geometry?.setDrawRange?.(0, Math.min(540, particles.geometry?.getAttribute?.('position')?.count || 540));
  }

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: 0 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uGravity;

      const float TAU = 6.283185307179586;

      mat2 rot(float a){
        float c = cos(a), s = sin(a);
        return mat2(c,-s,s,c);
      }

      float bell(float x, float width){
        float q = x / max(width, 0.0001);
        return exp(-q*q);
      }

      float hash21(vec2 p){
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise2(vec2 p){
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f*f*(3.0-2.0*f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0,0.0));
        float c = hash21(i + vec2(0.0,1.0));
        float d = hash21(i + vec2(1.0,1.0));
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
      }

      void main(){
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float g = clamp(uGravity, 0.0, 1.0);

        // Story-energy envelope. Peak is around 17–19 seconds, then it settles
        // before the 24-second loop restarts.
        float phase = mod(uTime, 24.0) / 24.0;
        float build = smoothstep(0.22, 0.70, phase) * (1.0 - smoothstep(0.88, 1.0, phase));
        float eventPeak = smoothstep(0.66, 0.715, phase) * (1.0 - smoothstep(0.78, 0.90, phase));
        float energy = clamp(max(g, 0.10 + build * 0.34 + eventPeak * 0.20), 0.0, 1.0);
        float cyc = phase * TAU;

        // A slight presentation angle prevents the disk from reading as a flat icon.
        vec2 q = rot(-0.105) * p;

        // 1) Black-hole shadow + razor-thin photon ring.
        float coreR = 0.208 + energy * 0.004;
        float core = 1.0 - smoothstep(coreR, coreR + 0.006, r);
        float photonR = coreR + 0.014;
        float photon = bell(r - photonR, 0.0062);
        float photonFine = bell(r - (photonR + 0.010), 0.0045) * 0.45;
        float lensGlow = bell(r - (coreR + 0.052), 0.028) * (0.12 + energy * 0.10);

        // 2) Inclined accretion disk. Thin, turbulent, asymmetric.
        vec2 e = vec2(q.x, q.y * 5.45);
        float er = length(e);
        float ea = atan(e.y, e.x);
        float spin = cyc * (2.0 + energy * 2.7);
        float n1 = noise2(vec2(ea * 3.2 + spin * 0.35, er * 13.0 - spin));
        float n2 = noise2(vec2(ea * 8.5 - spin * 0.42, er * 25.0 + spin * 0.7));
        float turbulence = (n1 - 0.5) * 0.045 + (n2 - 0.5) * 0.018;

        float innerEdge = 0.365 + turbulence;
        float outerEdge = 0.985 + turbulence * 0.45;
        float radialWindow = smoothstep(innerEdge, innerEdge + 0.035, er)
                           * (1.0 - smoothstep(outerEdge - 0.08, outerEdge, er));
        float streamA = bell(er - (0.53 + turbulence), 0.045);
        float streamB = bell(er - (0.68 - turbulence * 0.6), 0.070) * 0.56;
        float streamC = bell(er - (0.82 + turbulence * 0.35), 0.090) * 0.26;
        float streak = 0.72 + 0.28 * sin(ea * 34.0 - spin * 6.0 + er * 51.0);
        float micro = 0.78 + 0.22 * sin(ea * 79.0 + spin * 3.5 - er * 94.0);
        float disk = (streamA + streamB + streamC) * radialWindow * streak * micro;
        float heat = 1.0 - smoothstep(0.38, 0.92, er);

        // Relativistic beaming / color asymmetry.
        float approach = smoothstep(-0.80, 0.68, -q.x);
        float beam = mix(0.54, 1.46, approach);
        vec3 receding = vec3(1.00, 0.18, 0.025);
        vec3 amber = vec3(1.00, 0.46, 0.075);
        vec3 warmWhite = vec3(1.00, 0.90, 0.69);
        vec3 blueWhite = vec3(0.78, 0.90, 1.00);
        vec3 diskColor = mix(receding, amber, 0.42 + heat * 0.24);
        diskColor = mix(diskColor, warmWhite, heat * 0.74);
        diskColor = mix(diskColor, blueWhite, approach * heat * 0.34);
        diskColor *= beam * (0.86 + energy * 0.38);

        // 3) Near-side band crosses in front of the shadow.
        float yWarp = q.y + 0.014 * sin(q.x * 7.0 - spin * 2.1);
        float nearBand = bell(yWarp, 0.020 + energy * 0.004)
                       * smoothstep(0.17, 0.30, abs(q.x))
                       * (1.0 - smoothstep(0.83, 1.03, abs(q.x)));
        nearBand *= 0.72 + 0.28 * sin(q.x * 53.0 - spin * 7.0);
        nearBand *= mix(0.65, 1.35, smoothstep(-0.76, 0.72, -q.x));

        // 4) Gravitational lensing — compressed far-side arcs above/below the shadow.
        float arcR = coreR + 0.086;
        float arcShell = bell(r - arcR, 0.018);
        float xGate = 1.0 - smoothstep(0.43, 0.78, abs(q.x));
        float upperGate = smoothstep(0.025, 0.095, q.y);
        float lowerGate = 1.0 - smoothstep(-0.095, -0.025, q.y);
        float upperArc = arcShell * upperGate * xGate;
        float lowerArc = arcShell * lowerGate * xGate * 0.58;
        float secondaryArc = bell(r - (arcR + 0.034), 0.010)
                           * (upperGate + lowerGate * 0.32)
                           * (1.0 - smoothstep(0.30, 0.66, abs(q.x)))
                           * 0.32;
        float lensed = upperArc + lowerArc + secondaryArc;

        // 5) Sparse infall streaks only near the dramatic peak.
        float pa = atan(q.y, q.x);
        float spoke = pow(max(0.0, sin(pa * 13.0 - spin * 4.5)), 18.0);
        float infallWindow = smoothstep(0.34, 0.48, r) * (1.0 - smoothstep(0.62, 0.98, r));
        float infall = spoke * infallWindow * (0.10 + eventPeak * 0.44 + g * 0.18);

        float diskAlpha = clamp(disk * 0.88 + nearBand * 0.96 + lensed * (0.76 + energy * 0.18), 0.0, 1.0);
        float ringAlpha = clamp(photon * (0.96 + eventPeak * 0.20) + photonFine + lensGlow, 0.0, 1.0);
        float infallAlpha = clamp(infall, 0.0, 0.48);

        vec3 emission = diskColor * diskAlpha;
        emission += warmWhite * photon * (1.12 + energy * 0.30 + eventPeak * 0.34);
        emission += blueWhite * photonFine * (0.34 + approach * 0.34);
        emission += amber * lensGlow * 0.36;
        emission += warmWhite * lensed * (0.28 + energy * 0.12);
        emission += mix(amber, warmWhite, 0.6) * infallAlpha * 0.72;

        // The shadow stays physically dark. Only near-side material can cross it.
        float nearAcrossCore = nearBand * core;
        float opaqueShadow = core * (1.0 - smoothstep(0.10, 0.70, nearAcrossCore));
        float alpha = max(opaqueShadow, max(diskAlpha, max(ringAlpha, infallAlpha)));
        vec3 color = emission;
        if (opaqueShadow > 0.50 && nearAcrossCore < 0.10) {
          color = vec3(0.0);
        } else if (core > 0.28) {
          color = mix(vec3(0.0), emission, clamp(nearAcrossCore * 1.50, 0.0, 1.0));
        }

        // Crisp transparent edge; no portal-like circular glow.
        float outerFade = 1.0 - smoothstep(0.90, 1.12, r);
        alpha *= outerFade;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `
  });

  const geometry = new THREE.PlaneGeometry(2.58, 2.58, 1, 1);
  heroPlane = new THREE.Mesh(geometry, material);
  heroPlane.name = 'ScientificCinematicBlackHole';
  heroPlane.position.set(0, 0.78, 0);
  heroPlane.renderOrder = 2;
  heroPlane.frustumCulled = false;
  hole.add(heroPlane);
  hole.userData.heroPlane = heroPlane;
  document.documentElement.dataset.bhHero = 'scientific-cinematic-v9';
}

function findBlackHole(scene) {
  if (cachedBlackHole?.parent) return cachedBlackHole;
  cachedBlackHole = null;
  scene?.traverse?.((obj) => {
    if (cachedBlackHole) return;
    const u = obj.userData;
    if (u?.core && u?.disk && u?.particles && u?.lens) cachedBlackHole = obj;
  });
  return cachedBlackHole;
}

function publishScreenAnchor(hole, viewCamera) {
  const core = hole?.userData?.core;
  if (!core || !viewCamera) return;

  core.getWorldPosition(coreWorld);
  ndc.copy(coreWorld).project(viewCamera);

  const visible = ndc.z > -1.15 && ndc.z < 1.15 && Math.abs(ndc.x) < 1.25 && Math.abs(ndc.y) < 1.25;
  document.documentElement.dataset.bhScreenVisible = visible ? '1' : '0';
  if (!visible) return;

  const x = (ndc.x * 0.5 + 0.5) * innerWidth;
  const y = (-ndc.y * 0.5 + 0.5) * innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--bh-screen-x', `${x.toFixed(1)}px`);
  root.setProperty('--bh-screen-y', `${y.toFixed(1)}px`);
}

function updateHeroVisual(renderer, scene, camera) {
  const hole = findBlackHole(scene);
  if (!hole) return;

  buildHeroBlackHole(hole);
  if (!heroPlane) return;

  const particleGravity = hole.userData?.particles?.material?.uniforms?.uGravity?.value;
  const gravity = Number.isFinite(particleGravity) ? particleGravity : 0;
  heroPlane.material.uniforms.uGravity.value = gravity;
  heroPlane.material.uniforms.uTime.value = performance.now() / 1000;

  let viewCamera = camera;
  if (renderer.xr?.isPresenting) {
    const xrCamera = renderer.xr.getCamera(camera);
    viewCamera = xrCamera?.cameras?.[0] || xrCamera || camera;
  }

  // World-space camera-facing billboard: correct AR position, scale and parallax.
  viewCamera.getWorldQuaternion(camQuat);
  hole.getWorldQuaternion(parentQuat);
  parentQuat.invert();
  heroPlane.quaternion.copy(parentQuat).multiply(camQuat);

  publishScreenAnchor(hole, viewCamera);

  const { core, halo, disk, lens } = hole.userData;
  if (core) core.visible = false;
  if (halo) halo.visible = false;
  if (disk) disk.visible = false;
  if (lens) lens.visible = false;
}

THREE.WebGLRenderer.prototype.render = function patchedBlackHoleRender(scene, camera) {
  try { updateHeroVisual(this, scene, camera); } catch (err) {
    console.info('[AR Black Hole] hero visual fallback:', err?.message || err);
  }
  return originalRender.call(this, scene, camera);
};

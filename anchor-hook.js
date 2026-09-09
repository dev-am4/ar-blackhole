import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

/*
 * Option A / production fast path:
 * - no WebP/video overlay
 * - no realtime chroma key
 * - transparent procedural black-hole billboard rendered inside the existing WebGL scene
 * - legacy core/disk/halo/lens are hidden; existing GPU particles stay interactive
 * - the shader is exactly 24s-periodic so it matches the story loop
 */

const originalRender = THREE.WebGLRenderer.prototype.render;
const camQuat = new THREE.Quaternion();
const parentQuat = new THREE.Quaternion();
let cachedBlackHole = null;
let fastPlane = null;

function buildFastBlackHole(hole) {
  if (fastPlane || !hole?.userData) return;

  const { core, halo, disk, particles, lens } = hole.userData;
  if (core) core.visible = false;
  if (halo) halo.visible = false;
  if (disk) disk.visible = false;
  if (lens) lens.visible = false;

  if (particles) {
    particles.visible = true;
    particles.renderOrder = 1;
  }

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
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

      const float PI = 3.141592653589793;
      const float TAU = 6.283185307179586;

      float gauss(float x, float k){
        return exp(-x*x*k);
      }

      mat2 rot(float a){
        float c = cos(a), s = sin(a);
        return mat2(c,-s,s,c);
      }

      void main(){
        vec2 p = (vUv - 0.5) * 2.0;
        float g = clamp(uGravity, 0.0, 1.0);

        // Exactly periodic every 24 seconds.
        float cyc = mod(uTime, 24.0) * TAU / 24.0;
        p = rot(0.045 + 0.012 * sin(cyc)) * p;

        float r = length(p);
        float coreR = 0.235 + 0.008 * g;
        float core = 1.0 - smoothstep(coreR, coreR + 0.010, r);

        // Thin photon ring wrapped tightly around the Event Horizon.
        float photon = gauss((r - (coreR + 0.020)) * 82.0, 1.0);
        float photonHalo = gauss((r - (coreR + 0.035)) * 34.0, 1.0) * 0.34;

        // Flattened accretion disk. Angular streaks are periodic with the 24s cycle.
        vec2 d = vec2(p.x, p.y * 4.15);
        float dr = length(d);
        float a = atan(d.y, d.x);
        float wobble =
          0.020 * sin(a * 15.0 - cyc * 8.0 + dr * 19.0) +
          0.012 * sin(a * 31.0 + cyc * 5.0 - dr * 37.0);

        float bandA = gauss((dr - (0.60 + wobble)) * 24.0, 1.0);
        float bandB = gauss((dr - (0.70 - wobble * 0.45)) * 13.0, 1.0) * 0.36;
        float radialWindow = smoothstep(0.30, 0.38, dr) * (1.0 - smoothstep(0.96, 1.04, dr));
        float streaks = 0.58 + 0.42 * sin(a * 28.0 - cyc * (10.0 + g * 6.0) + dr * 42.0);
        streaks = mix(0.72, 1.0, streaks * streaks);
        float disk = (bandA + bandB) * radialWindow * streaks;

        // Horizontal near-side material in front of the black hole.
        float frontBand = gauss(p.y * 58.0, 1.0)
                        * smoothstep(0.19, 0.29, abs(p.x))
                        * (1.0 - smoothstep(0.82, 0.96, abs(p.x)));
        frontBand *= 0.78 + 0.22 * sin(p.x * 46.0 - cyc * 9.0);

        // Gravitationally lensed copy of the far side above/below the horizon.
        float lensRing = gauss((r - 0.335) * 47.0, 1.0);
        float upper = lensRing * smoothstep(-0.02, 0.10, p.y) * (1.0 - smoothstep(0.55, 0.88, abs(p.x)));
        float lower = lensRing * (1.0 - smoothstep(-0.10, 0.02, p.y)) * 0.58;
        float lensed = upper + lower;

        // Relativistic beaming: one side is slightly brighter.
        float beam = mix(0.78, 1.18, smoothstep(-0.72, 0.72, -p.x));
        float heat = 1.0 - smoothstep(0.34, 0.92, dr);
        vec3 amber = vec3(1.00, 0.29, 0.035);
        vec3 gold  = vec3(1.00, 0.64, 0.18);
        vec3 whiteHot = vec3(1.00, 0.94, 0.76);
        vec3 diskColor = mix(amber, gold, 0.42 + heat * 0.30);
        diskColor = mix(diskColor, whiteHot, heat * 0.72);
        diskColor *= beam * (1.0 + g * 0.24);

        float diskAlpha = clamp(disk * (0.92 + g * 0.30) + frontBand * 0.92 + lensed * 0.78, 0.0, 1.0);
        float ringAlpha = clamp(photon * 0.96 + photonHalo * (0.78 + g * 0.30), 0.0, 1.0);
        float emissionAlpha = clamp(max(diskAlpha, ringAlpha), 0.0, 1.0);

        vec3 emission = diskColor * diskAlpha;
        emission += whiteHot * photon * (1.05 + g * 0.32);
        emission += gold * photonHalo * 0.72;
        emission += whiteHot * lensed * 0.30;

        // The black core stays opaque, except where the near-side disk crosses it.
        float frontAcrossCore = frontBand * core;
        float coreOnly = core * (1.0 - smoothstep(0.10, 0.68, frontAcrossCore));
        float alpha = max(coreOnly, emissionAlpha);
        vec3 color = emission;

        if (coreOnly > 0.50 && frontAcrossCore < 0.12) {
          color = vec3(0.0);
        } else if (core > 0.35) {
          color = mix(vec3(0.0), emission, clamp(frontAcrossCore * 1.55, 0.0, 1.0));
        }

        // Transparent everywhere outside the actual black-hole visual.
        float outerFade = 1.0 - smoothstep(0.88, 1.08, r);
        alpha *= outerFade;

        if (alpha < 0.004) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `
  });

  const geometry = new THREE.PlaneGeometry(2.40, 2.40, 1, 1);
  fastPlane = new THREE.Mesh(geometry, material);
  fastPlane.name = 'FastTransparentBlackHole';
  fastPlane.position.set(0, 0.78, 0);
  fastPlane.renderOrder = 2;
  fastPlane.frustumCulled = false;
  hole.add(fastPlane);
  hole.userData.fastPlane = fastPlane;

  document.documentElement.dataset.bhFast = '1';
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

function updateFastVisual(renderer, scene, camera) {
  const hole = findBlackHole(scene);
  if (!hole) return;

  buildFastBlackHole(hole);
  if (!fastPlane) return;

  // blackhole.js updates gravity on the existing particle shader; reuse it.
  const particleGravity = hole.userData?.particles?.material?.uniforms?.uGravity?.value;
  const gravity = Number.isFinite(particleGravity) ? particleGravity : 0;
  fastPlane.material.uniforms.uGravity.value = gravity;
  fastPlane.material.uniforms.uTime.value = performance.now() / 1000;

  let viewCamera = camera;
  if (renderer.xr?.isPresenting) {
    const xrCamera = renderer.xr.getCamera(camera);
    viewCamera = xrCamera?.cameras?.[0] || xrCamera || camera;
  }

  // Camera-facing world billboard: retains correct AR position, scale and parallax,
  // while avoiding a 2D DOM element stuck to the phone screen.
  viewCamera.getWorldQuaternion(camQuat);
  hole.getWorldQuaternion(parentQuat);
  parentQuat.invert();
  fastPlane.quaternion.copy(parentQuat).multiply(camQuat);

  // Re-assert hidden legacy parts in case another frame modifies them.
  const { core, halo, disk, lens } = hole.userData;
  if (core) core.visible = false;
  if (halo) halo.visible = false;
  if (disk) disk.visible = false;
  if (lens) lens.visible = false;
}

THREE.WebGLRenderer.prototype.render = function patchedBlackHoleRender(scene, camera) {
  try { updateFastVisual(this, scene, camera); } catch (err) {
    console.info('[AR Black Hole] fast visual fallback:', err?.message || err);
  }
  return originalRender.call(this, scene, camera);
};

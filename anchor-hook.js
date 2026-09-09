import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

/*
 * Keeps the 24s cinematic layer visually attached to the procedural black hole
 * without changing the AR placement core. This module patches the shared
 * Three.js renderer before blackhole.js creates its renderer.
 */
const originalRender = THREE.WebGLRenderer.prototype.render;
const ndc = new THREE.Vector3();
const coreWorld = new THREE.Vector3();
const cameraWorld = new THREE.Vector3();
let cachedBlackHole = null;

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

function updateAnchor(renderer, scene, camera) {
  const root = document.documentElement;
  const hole = findBlackHole(scene);

  if (!hole || !hole.visible) {
    root.dataset.bhAnchor = '0';
    return;
  }

  let viewCamera = camera;
  if (renderer.xr?.isPresenting) {
    const xrCamera = renderer.xr.getCamera(camera);
    viewCamera = xrCamera?.cameras?.[0] || xrCamera || camera;
  }

  hole.userData.core.getWorldPosition(coreWorld);
  viewCamera.getWorldPosition(cameraWorld);
  ndc.copy(coreWorld).project(viewCamera);

  const inFront = ndc.z > -1.2 && ndc.z < 1.2;
  const nearScreen = Math.abs(ndc.x) < 1.35 && Math.abs(ndc.y) < 1.35;
  const visible = inFront && nearScreen;
  root.dataset.bhAnchor = visible ? '1' : '0';
  if (!visible) return;

  const x = (ndc.x * 0.5 + 0.5) * innerWidth;
  const y = (-ndc.y * 0.5 + 0.5) * innerHeight;
  const distance = Math.max(0.35, cameraWorld.distanceTo(coreWorld));
  const fov = Number.isFinite(viewCamera.fov) ? viewCamera.fov : 62;
  const focalPx = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5));
  const worldDiameter = 1.78 * Math.max(0.55, hole.scale.x || 1);
  const projected = focalPx * worldDiameter / distance;
  const size = THREE.MathUtils.clamp(projected, 150, Math.min(innerWidth * 0.82, innerHeight * 0.72));

  const style = root.style;
  style.setProperty('--bh-x', `${x.toFixed(1)}px`);
  style.setProperty('--bh-y', `${y.toFixed(1)}px`);
  style.setProperty('--bh-size', `${size.toFixed(1)}px`);
  style.setProperty('--bh-distance', distance.toFixed(3));
}

THREE.WebGLRenderer.prototype.render = function patchedBlackHoleRender(scene, camera) {
  try { updateAnchor(this, scene, camera); } catch { /* visual enhancement only */ }
  return originalRender.call(this, scene, camera);
};

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

/*
 * Anchor Hook & Screen Space Coordinator for Realistic 3D Black Hole
 *
 * Coordinates screen-space anchors for WOW layer & HUD effects
 * while allowing the full 3D relativistic black hole to render natively in 6DoF space.
 */

const coreWorld = new THREE.Vector3();
const ndc = new THREE.Vector3();

export function publishScreenAnchor(blackHole, viewCamera) {
  if (!blackHole || !viewCamera) return;
  const core = blackHole.userData?.core || blackHole;
  core.getWorldPosition(coreWorld);
  ndc.copy(coreWorld).project(viewCamera);

  const visible = ndc.z > -1.15 && ndc.z < 1.15 && Math.abs(ndc.x) < 1.4 && Math.abs(ndc.y) < 1.4;
  document.documentElement.dataset.bhScreenVisible = visible ? '1' : '0';
  if (!visible) return;

  const x = (ndc.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-ndc.y * 0.5 + 0.5) * window.innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--bh-screen-x', `${x.toFixed(1)}px`);
  root.setProperty('--bh-screen-y', `${y.toFixed(1)}px`);
}

// Global anchor update helper for blackhole.js
window.__publishScreenAnchor = publishScreenAnchor;

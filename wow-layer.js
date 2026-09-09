const $ = (s) => document.querySelector(s);

const ar = $('#ar');
const meterValue = $('#meterValue');
const pulseBtn = $('#pulseBtn');
const placeBtn = $('#placeBtn');
const moveBtn = $('#moveBtn');
const gravityFact = document.querySelector('.gravity-fact');

/*
 * Cinematic overlay deliberately contains NO text in the middle of the camera.
 * Story copy lives inside the existing gravity card at the top of the screen,
 * leaving the black hole / Event Horizon unobstructed.
 */
const wow = document.createElement('div');
wow.id = 'wowLayer';
wow.innerHTML = `
  <div class="wow-vignette"></div>
  <div class="wow-lens"></div>
  <div class="wow-streaks" aria-hidden="true"></div>
  <div class="wow-shockwave" aria-hidden="true"></div>
  <div class="wow-flash" aria-hidden="true"></div>
`;
document.body.appendChild(wow);

if (gravityFact) {
  gravityFact.innerHTML = `
    <span class="story-step" id="storyStep">01 / 07</span>
    <strong id="storyTitle">หลุมดำอยู่ตรงหน้า</strong>
    <span class="story-copy" id="storyText">เริ่มสำรวจสนามแรงโน้มถ่วงรอบหลุมดำ</span>
    <span class="story-progress" aria-hidden="true"><i id="storyProgress"></i></span>
  `;
}

const storyStep = $('#storyStep');
const storyTitle = $('#storyTitle');
const storyText = $('#storyText');
const storyProgress = $('#storyProgress');

let lastLevel = -1;
let burstLocked = false;
let placed = false;
let gravity = 0;
let storyStart = 0;
let storyIndex = -1;
let nextAutoBoostAt = 0;
let userOverrideUntil = 0;

const REDUCED_MOTION = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
const STORY_DURATION = 24000;

/*
 * One complete 24-second narration cycle, matching blackhole_24s.webp.
 * The visitor can still interact at any time; trusted input temporarily wins
 * over the automatic gravity drive.
 */
const STORY = [
  { start: 0,     title: 'หลุมดำอยู่ตรงหน้า',          text: 'เริ่มสำรวจสนามแรงโน้มถ่วงรอบหลุมดำ',                    boost: 'none' },
  { start: 3000,  title: 'สสารเข้าสู่วงโคจร',          text: 'ก๊าซและฝุ่นเริ่มหมุนรอบหลุมดำด้วยความเร็วสูง',             boost: 'soft' },
  { start: 6500,  title: 'จานสะสมมวลร้อนขึ้น',         text: 'การเสียดสีทำให้สสารร้อนและส่องสว่างมากขึ้น',              boost: 'medium' },
  { start: 10000, title: 'แสงเริ่มเบนโค้ง',            text: 'แรงโน้มถ่วงบิดเส้นทางของแสงรอบหลุมดำ',                    boost: 'medium' },
  { start: 13500, title: 'เข้าใกล้ขอบฟ้าเหตุการณ์',    text: 'สนามแรงโน้มถ่วงกำลังเข้าสู่ระดับสุดขั้ว',                  boost: 'high' },
  { start: 17000, title: 'EVENT HORIZON',              text: 'เมื่อผ่านขอบนี้ แม้แต่แสงก็ไม่สามารถกลับออกมาได้',          boost: 'event' },
  { start: 21000, title: 'สนามค่อย ๆ สงบลง',           text: 'อีกไม่กี่วินาที การสำรวจจะเริ่มต้นใหม่อีกครั้ง',            boost: 'none' }
];

function levelFor(v) {
  if (v >= 96) return 4;
  if (v >= 78) return 3;
  if (v >= 52) return 2;
  if (v >= 24) return 1;
  return 0;
}

function resetWow() {
  placed = false;
  storyStart = 0;
  storyIndex = -1;
  nextAutoBoostAt = 0;
  wow.classList.remove('active', 'danger', 'burst', 'manual-pulse');
  applyVisualVars(0);
  lastLevel = -1;
  if (storyProgress) storyProgress.style.transform = 'scaleX(0)';
  window.dispatchEvent(new CustomEvent('blackhole-story-reset'));
}

function syncPlacement() {
  const nowPlaced = !!pulseBtn && !pulseBtn.hidden;
  if (nowPlaced === placed) return;
  placed = nowPlaced;
  if (placed) {
    wow.classList.add('active');
    storyStart = performance.now();
    storyIndex = -1;
    nextAutoBoostAt = 0;
    window.dispatchEvent(new CustomEvent('blackhole-story-start'));
    updateStory(performance.now(), true);
  } else {
    resetWow();
  }
}

function burst() {
  if (burstLocked || !placed) return;
  burstLocked = true;
  wow.classList.remove('burst');
  void wow.offsetWidth;
  wow.classList.add('burst');
  navigator.vibrate?.([30, 40, 70, 35, 90]);
  setTimeout(() => wow.classList.remove('burst'), 1100);
  setTimeout(() => { burstLocked = false; }, 2200);
}

function applyVisualVars(g) {
  const root = document.documentElement.style;
  root.setProperty('--wow-gravity', g.toFixed(3));
  root.setProperty('--wow-vignette-a', (g * 0.58).toFixed(3));
  root.setProperty('--wow-mid-a', (g * 0.06).toFixed(3));
  root.setProperty('--wow-shadow-a', (g * 0.22).toFixed(3));
  root.setProperty('--wow-shadow-blur', `${Math.round(g * 120)}px`);
  root.setProperty('--wow-lens-opacity', (g * 0.85).toFixed(3));
  root.setProperty('--wow-lens-blur', `${(g * 1.4).toFixed(2)}px`);
  root.setProperty('--wow-lens-scale', (1 + g * 0.025).toFixed(4));
  root.setProperty('--wow-saturate', (1 + g * 0.55).toFixed(3));
  root.setProperty('--wow-streak-opacity', Math.max(0, Math.min(0.82, (g - 0.18) * 1.35)).toFixed(3));
  root.setProperty('--wow-streak-width', `${Math.round(g * 30)}px`);
  root.setProperty('--wow-streak-scale', (0.3 + g * 1.7).toFixed(3));
  root.setProperty('--wow-blue-a', (g * 0.025).toFixed(3));
  root.setProperty('--wow-red-a', (g * 0.03).toFixed(3));
}

function applyGravity(v) {
  gravity = Math.max(0, Math.min(100, v));
  const g = gravity / 100;
  applyVisualVars(g);
  wow.classList.toggle('active', placed);
  wow.classList.toggle('danger', placed && gravity >= 78);

  const level = levelFor(gravity);
  if (level !== lastLevel) lastLevel = level;
  if (gravity >= 97) burst();
}

function readMeter() {
  if (!meterValue) return;
  syncPlacement();
  const v = Number((meterValue.textContent || '0').replace(/[^0-9.]/g, '')) || 0;
  applyGravity(v);
}

function phaseAt(elapsed) {
  let idx = STORY.length - 1;
  for (let i = 0; i < STORY.length; i++) {
    if (elapsed < STORY[i].start) break;
    idx = i;
  }
  return idx;
}

function showStoryPhase(idx) {
  const item = STORY[idx];
  if (!item) return;
  if (storyStep) storyStep.textContent = `${String(idx + 1).padStart(2, '0')} / ${String(STORY.length).padStart(2, '0')}`;
  if (storyTitle) storyTitle.textContent = item.title;
  if (storyText) storyText.textContent = item.text;
  gravityFact?.classList.toggle('story-event', item.boost === 'event');
  window.dispatchEvent(new CustomEvent('blackhole-story-phase', { detail: { index: idx, elapsed: item.start } }));
}

function syntheticPointer(type, buttons = 0) {
  try {
    document.body.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      buttons
    }));
  } catch {
    /* Old Safari: narration still loops even if synthetic pointer is unavailable. */
  }
}

function autoBoost(mode, now) {
  if (REDUCED_MOTION || now < userOverrideUntil || mode === 'none') return;
  if (now < nextAutoBoostAt) return;

  if (mode === 'soft') {
    syntheticPointer('pointerdown', 1);
    nextAutoBoostAt = now + 1400;
  } else if (mode === 'medium') {
    syntheticPointer('pointerdown', 1);
    nextAutoBoostAt = now + 750;
  } else if (mode === 'high') {
    syntheticPointer('pointermove', 1);
    nextAutoBoostAt = now + 340;
  } else if (mode === 'event') {
    syntheticPointer('pointermove', 1);
    nextAutoBoostAt = now + 100;
  }
}

function updateStory(now, force = false) {
  if (!placed || !storyStart) return;
  const elapsed = (now - storyStart) % STORY_DURATION;
  const idx = phaseAt(elapsed);

  if (force || idx !== storyIndex) {
    storyIndex = idx;
    nextAutoBoostAt = 0;
    showStoryPhase(idx);
  }

  if (storyProgress) storyProgress.style.transform = `scaleX(${(elapsed / STORY_DURATION).toFixed(4)})`;
  autoBoost(STORY[idx].boost, now);
}

if (meterValue) {
  new MutationObserver(readMeter).observe(meterValue, { childList: true, subtree: true, characterData: true });
  readMeter();
}

if (pulseBtn) {
  new MutationObserver(syncPlacement).observe(pulseBtn, { attributes: true, attributeFilter: ['hidden'] });
}
if (placeBtn) {
  new MutationObserver(syncPlacement).observe(placeBtn, { attributes: true, attributeFilter: ['hidden'] });
}

placeBtn?.addEventListener('click', () => setTimeout(syncPlacement, 0));
moveBtn?.addEventListener('click', () => setTimeout(syncPlacement, 0));

/* Real visitor interaction temporarily takes priority over the automatic drive. */
addEventListener('pointerdown', (e) => {
  if (e.isTrusted && placed) userOverrideUntil = performance.now() + 3500;
}, true);
addEventListener('touchstart', (e) => {
  if (e.isTrusted && placed) userOverrideUntil = performance.now() + 3500;
}, { capture: true, passive: true });

pulseBtn?.addEventListener('click', (e) => {
  if (e.isTrusted) userOverrideUntil = performance.now() + 3500;
  wow.classList.add('manual-pulse');
  setTimeout(() => wow.classList.remove('manual-pulse'), 520);
});

ar?.addEventListener('transitionend', () => {
  if (!ar.classList.contains('on')) resetWow();
});

/* Lightweight ambient streak field: DOM only, no extra WebGL context. */
const streaks = wow.querySelector('.wow-streaks');
for (let i = 0; i < 28; i++) {
  const s = document.createElement('i');
  s.style.setProperty('--x', `${Math.random() * 100}%`);
  s.style.setProperty('--y', `${Math.random() * 100}%`);
  s.style.setProperty('--r', `${Math.random() * 360}deg`);
  s.style.setProperty('--d', `${1.4 + Math.random() * 2.8}s`);
  s.style.setProperty('--o', `${0.18 + Math.random() * 0.62}`);
  streaks.appendChild(s);
}

/* Narrative timing is cheap; 8 fps is enough for exhibition copy/progress. */
setInterval(() => updateStory(performance.now()), 125);

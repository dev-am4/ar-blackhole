const $ = (s) => document.querySelector(s);

const ar = $('#ar');
const meterValue = $('#meterValue');
const pulseBtn = $('#pulseBtn');
const placeBtn = $('#placeBtn');
const moveBtn = $('#moveBtn');

const wow = document.createElement('div');
wow.id = 'wowLayer';
wow.innerHTML = `
  <div class="wow-vignette"></div>
  <div class="wow-lens"></div>
  <div class="wow-streaks" aria-hidden="true"></div>
  <div class="wow-shockwave" aria-hidden="true"></div>
  <div class="wow-flash" aria-hidden="true"></div>
  <div class="wow-caption" role="status" aria-live="polite">
    <span class="wow-kicker">EXTREME GRAVITY</span>
    <strong id="wowTitle">แรงโน้มถ่วงกำลังเพิ่มขึ้น</strong>
    <small id="wowText">สังเกตแสงและอนุภาครอบหลุมดำ</small>
  </div>
`;
document.body.appendChild(wow);

const title = $('#wowTitle');
const text = $('#wowText');
const shockwave = wow.querySelector('.wow-shockwave');
const flash = wow.querySelector('.wow-flash');

let lastLevel = -1;
let burstLocked = false;
let placed = false;
let gravity = 0;

function levelFor(v) {
  if (v >= 96) return 4;
  if (v >= 78) return 3;
  if (v >= 52) return 2;
  if (v >= 24) return 1;
  return 0;
}

function setCaption(level) {
  if (!placed) return;
  const copy = [
    ['สนามแรงโน้มถ่วงเริ่มทำงาน', 'เข้าใกล้หลุมดำหรือแตะเร่งแรงดูด'],
    ['แสงเริ่มถูกบิด', 'สนามแรงโน้มถ่วงเข้มขึ้นรอบหลุมดำ'],
    ['การโคจรเร็วขึ้น', 'อนุภาคกำลังสูญเสียวงโคจรที่เสถียร'],
    ['เข้าใกล้ขอบฟ้าเหตุการณ์', 'ระวัง — แรงโน้มถ่วงอยู่ในระดับสูงมาก'],
    ['EVENT HORIZON', 'คุณกำลังจำลองสภาวะแรงโน้มถ่วงสุดขั้ว']
  ][level];
  title.textContent = copy[0];
  text.textContent = copy[1];
  wow.classList.toggle('caption-show', level >= 2);
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

function applyGravity(v) {
  gravity = Math.max(0, Math.min(100, v));
  const g = gravity / 100;
  document.documentElement.style.setProperty('--wow-gravity', g.toFixed(3));
  wow.classList.toggle('active', placed);
  wow.classList.toggle('danger', gravity >= 78);

  const level = levelFor(gravity);
  if (level !== lastLevel) {
    setCaption(level);
    lastLevel = level;
  }
  if (gravity >= 97) burst();
}

function readMeter() {
  if (!meterValue) return;
  const v = Number((meterValue.textContent || '0').replace(/[^0-9.]/g, '')) || 0;
  applyGravity(v);
}

if (meterValue) {
  new MutationObserver(readMeter).observe(meterValue, { childList: true, subtree: true, characterData: true });
  readMeter();
}

placeBtn?.addEventListener('click', () => {
  placed = true;
  wow.classList.add('active');
  setCaption(levelFor(gravity));
});

moveBtn?.addEventListener('click', () => {
  placed = false;
  wow.classList.remove('active', 'danger', 'caption-show', 'burst');
  document.documentElement.style.setProperty('--wow-gravity', '0');
  lastLevel = -1;
});

pulseBtn?.addEventListener('click', () => {
  wow.classList.add('manual-pulse');
  setTimeout(() => wow.classList.remove('manual-pulse'), 520);
});

ar?.addEventListener('transitionend', () => {
  if (!ar.classList.contains('on')) wow.classList.remove('active');
});

// Lightweight ambient streak field: DOM only, no extra WebGL context.
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

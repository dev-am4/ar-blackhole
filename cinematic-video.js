const ASSET = '/blackhole_24s.webp';

let image = null;
let wrap = null;
let active = false;
let ready = false;

function makeImage(){
  const holder = document.createElement('div');
  holder.id = 'cinematicBlackHoleWrap';
  holder.setAttribute('aria-hidden','true');

  const next = document.createElement('img');
  next.id = 'cinematicBlackHole';
  next.alt = '';
  next.setAttribute('aria-hidden','true');
  next.decoding = 'async';
  next.fetchPriority = 'high';
  next.draggable = false;

  next.addEventListener('load',()=>{
    ready = true;
    if(active) requestAnimationFrame(()=>holder.classList.add('on'));
  },{once:true});

  next.addEventListener('error',()=>{
    ready = false;
    holder.remove();
    image = null;
    wrap = null;
    console.info('[AR Black Hole] cinematic WebP unavailable; procedural visual remains active');
  },{once:true});

  holder.appendChild(next);
  document.body.appendChild(holder);
  image = next;
  wrap = holder;
  next.src = `${ASSET}?v=5`;
  return next;
}

function restart(){
  active = true;
  ready = false;
  wrap?.remove();
  image = null;
  wrap = null;
  makeImage();
}

function stop(){
  active = false;
  wrap?.classList.remove('on','event','cooldown');
}

window.addEventListener('blackhole-story-start',restart);
window.addEventListener('blackhole-story-reset',stop);
window.addEventListener('blackhole-story-phase',(e)=>{
  if(!wrap || !ready) return;
  const idx = e.detail?.index ?? 0;
  wrap.classList.toggle('event',idx === 5);
  wrap.classList.toggle('cooldown',idx === 6);
});

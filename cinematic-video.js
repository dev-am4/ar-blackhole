const ASSET = '/blackhole_24s.webp';

let image = null;
let active = false;
let ready = false;

function makeImage(){
  const next = document.createElement('img');
  next.id = 'cinematicBlackHole';
  next.alt = '';
  next.setAttribute('aria-hidden','true');
  next.decoding = 'async';
  next.draggable = false;

  next.addEventListener('load',()=>{
    ready = true;
    if(active) requestAnimationFrame(()=>next.classList.add('on'));
  },{once:true});

  next.addEventListener('error',()=>{
    ready = false;
    next.remove();
    image = null;
    console.info('[AR Black Hole] cinematic WebP unavailable; procedural visual remains active');
  },{once:true});

  document.body.appendChild(next);
  image = next;
  next.src = ASSET;
  return next;
}

function restart(){
  active = true;
  ready = false;
  image?.remove();
  makeImage();
}

function stop(){
  active = false;
  image?.classList.remove('on','event','cooldown');
}

window.addEventListener('blackhole-story-start',restart);
window.addEventListener('blackhole-story-reset',stop);
window.addEventListener('blackhole-story-phase',(e)=>{
  if(!image || !ready) return;
  const idx = e.detail?.index ?? 0;
  image.classList.toggle('event',idx === 5);
  image.classList.toggle('cooldown',idx === 6);
});

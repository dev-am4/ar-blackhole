const ASSET = '/blackhole_24s.webp?v=7';
const SIZE = 300;
const FRAME_MS = 83;

const arRoot = document.querySelector('#ar') || document.body;
let source = null;
let canvas = null;
let ctx = null;
let wrap = null;
let timer = 0;
let active = false;
let ready = false;
let edgeMask = null;

function makeEdgeMask(){
  const out = new Float32Array(SIZE * SIZE);
  const c = (SIZE - 1) * .5;
  const r = SIZE * .5;
  for(let y=0;y<SIZE;y++){
    for(let x=0;x<SIZE;x++){
      const dx = (x-c)/r;
      const dy = (y-c)/r;
      const d = Math.sqrt(dx*dx + dy*dy);
      out[y*SIZE+x] = Math.max(0, Math.min(1, (1.02-d)/.13));
    }
  }
  return out;
}

function keyFrame(){
  if(!ready || !ctx || !source?.naturalWidth) return;

  const iw = source.naturalWidth;
  const ih = source.naturalHeight;
  const crop = Math.min(iw, ih);
  const sx = Math.max(0, (iw-crop)*.5);
  const cy = ih * .52;
  const sy = Math.max(0, Math.min(ih-crop, cy-crop*.5));

  ctx.clearRect(0,0,SIZE,SIZE);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(source, sx, sy, crop, crop, 0, 0, SIZE, SIZE);

  const image = ctx.getImageData(0,0,SIZE,SIZE);
  const d = image.data;
  for(let p=0,i=0;p<edgeMask.length;p++,i+=4){
    const r=d[i], g=d[i+1], b=d[i+2];
    const hi=Math.max(r,g,b);
    const lo=Math.min(r,g,b);
    const chroma=hi-lo;

    // Remove the black space background with a soft threshold.
    // Warm plasma / stars survive while near-black pixels become transparent.
    let a=(hi-11)*6.2;
    if(hi < 39 && chroma < 8) a *= .28;
    a=Math.max(0,Math.min(255,a))*edgeMask[p];
    d[i+3]=a;
  }
  ctx.putImageData(image,0,0);

  // Rebuild the Event Horizon behind the luminous generated footage.
  // destination-over keeps the bright foreground accretion stream in front.
  ctx.save();
  ctx.globalCompositeOperation='destination-over';
  ctx.fillStyle='#000';
  ctx.beginPath();
  ctx.ellipse(SIZE*.5,SIZE*.5,SIZE*.168,SIZE*.19,0,0,Math.PI*2);
  ctx.fill();
  ctx.restore();
}

function startTicker(){
  stopTicker();
  keyFrame();
  timer = window.setInterval(keyFrame, FRAME_MS);
}

function stopTicker(){
  if(timer){
    clearInterval(timer);
    timer=0;
  }
}

function build(){
  const holder=document.createElement('div');
  holder.id='cinematicBlackHoleWrap';
  holder.setAttribute('aria-hidden','true');

  const cvs=document.createElement('canvas');
  cvs.id='cinematicBlackHole';
  cvs.width=SIZE;
  cvs.height=SIZE;
  cvs.setAttribute('aria-hidden','true');

  const img=document.createElement('img');
  img.className='cinematic-source';
  img.alt='';
  img.setAttribute('aria-hidden','true');
  img.decoding='async';
  img.fetchPriority='high';
  img.draggable=false;

  holder.appendChild(cvs);
  holder.appendChild(img);
  arRoot.prepend(holder);

  wrap=holder;
  canvas=cvs;
  ctx=cvs.getContext('2d',{willReadFrequently:true});
  source=img;
  edgeMask=makeEdgeMask();

  img.addEventListener('load',()=>{
    ready=true;
    startTicker();
    if(active) requestAnimationFrame(()=>holder.classList.add('on'));
  },{once:true});

  img.addEventListener('error',()=>{
    ready=false;
    stopTicker();
    holder.remove();
    source=canvas=ctx=wrap=null;
    console.info('[AR Black Hole] cinematic asset unavailable; interactive particles remain active');
  },{once:true});

  img.src=ASSET;
}

function restart(){
  active=true;
  if(!wrap) build();
  if(ready){
    startTicker();
    requestAnimationFrame(()=>wrap?.classList.add('on'));
  }
}

function stop(){
  active=false;
  wrap?.classList.remove('on','event','cooldown');
  stopTicker();
}

window.addEventListener('blackhole-story-start',restart);
window.addEventListener('blackhole-story-reset',stop);
window.addEventListener('blackhole-story-phase',(e)=>{
  if(!wrap || !ready) return;
  const idx=e.detail?.index ?? 0;
  wrap.classList.toggle('event',idx===5);
  wrap.classList.toggle('cooldown',idx===6);
});

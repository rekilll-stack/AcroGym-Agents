'use strict';
// PROTOTYPE v4 — branded IG STORY 1080x1920, WARM orange→pink scrim (Canva look).
const path=require('path');
const { createCanvas, loadImage, registerFont } = require('canvas');
const ROOT='/home/admin/acrogym';
const ORANGE='#F37021', PINK='#EC5E86', CREAM='#FBF1DF', WHITE='#FFFFFF';
const W=1080, H=1920;
registerFont(path.join(ROOT,'config/brand/fonts/LilitaOne.ttf'),{family:'Lilita One'});

function wrapLeft(ctx,t,m){const ws=String(t).trim().split(/\s+/);const ls=[];let c='';for(const w of ws){const x=c?c+' '+w:w;if(ctx.measureText(x).width<=m||!c)c=x;else{ls.push(c);c=w;}}if(c)ls.push(c);return ls;}
function fit(ctx,t,mW,mH,{max=150,min=60,lg=1.04}={}){for(let s=max;s>=min;s-=2){ctx.font=`${s}px "Lilita One"`;const ls=wrapLeft(ctx,t,mW);if(ls.length*s*lg<=mH)return{s,ls,lg};}ctx.font=`${min}px "Lilita One"`;return{s:min,ls:wrapLeft(ctx,t,mW),lg};}
function roundRect(ctx,x,y,w,h,r){const rr=Math.min(r,h/2,w/2);ctx.beginPath();ctx.moveTo(x+rr,y);ctx.arcTo(x+w,y,x+w,y+h,rr);ctx.arcTo(x+w,y+h,x,y+h,rr);ctx.arcTo(x,y+h,x,y,rr);ctx.arcTo(x,y,x+w,y,rr);ctx.closePath();}
function asterisk(ctx,cx,cy,r,color){ctx.save();ctx.strokeStyle=color;ctx.lineWidth=Math.max(9,r*0.34);ctx.lineCap='round';for(let i=0;i<5;i++){const a=(Math.PI/2)+(i*2*Math.PI/5);ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(a)*r,cy-Math.sin(a)*r);ctx.stroke();}ctx.restore();}

async function compose({backgroundPath,text,pill='Building skills together'}){
  const canvas=createCanvas(W,H);const ctx=canvas.getContext('2d');
  const bg=await loadImage(path.join(ROOT,backgroundPath));
  const sc=Math.max(W/bg.width,H/bg.height);const bw=bg.width*sc,bh=bg.height*sc;
  ctx.drawImage(bg,(W-bw)/2,(H-bh)/2,bw,bh);
  // WARM AMBER GRADE over the whole photo (Canva look) — richer, not pastel
  ctx.save();
  ctx.globalCompositeOperation='multiply'; ctx.fillStyle='rgba(238,108,28,0.34)'; ctx.fillRect(0,0,W,H);
  ctx.globalCompositeOperation='overlay';  ctx.fillStyle='rgba(245,130,40,0.42)'; ctx.fillRect(0,0,W,H);
  ctx.globalCompositeOperation='screen';   ctx.fillStyle='rgba(255,170,70,0.12)'; ctx.fillRect(0,0,W,H);
  const vg=ctx.createRadialGradient(W/2,H*0.42,H*0.22,W/2,H*0.5,H*0.78);
  vg.addColorStop(0,'rgba(70,28,6,0)'); vg.addColorStop(1,'rgba(70,28,6,0.40)');
  ctx.globalCompositeOperation='source-over'; ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);
  ctx.restore();
  // top scrim — soft dark-warm so white logo reads
  let gt=ctx.createLinearGradient(0,0,0,420);gt.addColorStop(0,'rgba(60,24,8,0.55)');gt.addColorStop(1,'rgba(60,24,8,0)');ctx.fillStyle=gt;ctx.fillRect(0,0,W,420);
  // bottom scrim — WARM orange→pink wash, near-solid orange at the very bottom
  let gb=ctx.createLinearGradient(0,1050,0,H);
  gb.addColorStop(0,'rgba(236,94,134,0)');      // transparent
  gb.addColorStop(0.45,'rgba(236,94,134,0.55)'); // pink mid
  gb.addColorStop(1,'rgba(243,112,33,0.96)');    // strong orange ground
  ctx.fillStyle=gb;ctx.fillRect(0,1050,W,H-1050);
  // logo top-center (white)
  try{const lg=await loadImage(path.join(ROOT,'config/brand/logo-white.png'));const tg=205,s=tg/Math.max(lg.width,lg.height);ctx.drawImage(lg,(W-lg.width*s)/2,38,lg.width*s,lg.height*s);}catch{}
  // headline — cream Lilita, left
  const marginL=80, pillH=72, pillBottom=H-300, blockMaxW=W-marginL-90, headMaxH=620;
  const {s,ls,lg}=fit(ctx,text,blockMaxW,headMaxH);
  ctx.font=`${s}px "Lilita One"`;ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillStyle=CREAM;
  ctx.shadowColor='rgba(120,30,10,0.45)';ctx.shadowBlur=14;ctx.shadowOffsetY=3;
  const lineH=s*lg, blockH=ls.length*lineH, topBaseline=pillBottom-pillH-48;
  let by=topBaseline-blockH+s; const blockTopY=by-s;
  for(const line of ls){ctx.fillText(line,marginL,by);by+=lineH;}
  ctx.shadowColor='transparent';
  // asterisk — WHITE/cream so it shows on orange
  asterisk(ctx,W-150,blockTopY+50,52,CREAM);
  // pill — WHITE fill, ORANGE text+arrow (contrast on orange ground)
  ctx.font='34px "Lilita One"';const label=String(pill).toUpperCase();const lw=ctx.measureText(label).width;
  const padX=34,aGap=24,aLen=38,pillW=padX*2+lw+aGap+aLen,pillY=pillBottom-pillH;
  roundRect(ctx,marginL,pillY,pillW,pillH,pillH/2);ctx.fillStyle=WHITE;ctx.fill();
  ctx.fillStyle=ORANGE;ctx.textBaseline='middle';ctx.fillText(label,marginL+padX,pillY+pillH/2+2);
  const ax=marginL+padX+lw+aGap,ayc=pillY+pillH/2;ctx.strokeStyle=ORANGE;ctx.lineWidth=6;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(ax,ayc);ctx.lineTo(ax+aLen,ayc);ctx.moveTo(ax+aLen-13,ayc-11);ctx.lineTo(ax+aLen,ayc);ctx.lineTo(ax+aLen-13,ayc+11);ctx.stroke();
  return canvas.toBuffer('image/png');
}
(async()=>{
  const buf=await compose({backgroundPath:'config/brand/backgrounds/bg-kids-motion.jpg',text:'Enrolment is now open'});
  require('fs').writeFileSync(process.argv[1].replace(/story-proto\.js$/,'story-sample-v6.png'),buf);
  console.log('v4 written:',buf.length,'bytes');
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});

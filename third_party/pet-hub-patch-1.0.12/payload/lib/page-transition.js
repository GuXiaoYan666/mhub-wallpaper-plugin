'use strict';

// Serialized into the host document. Keep this function self-contained.
function installEntrance(token) {
  if (window.__friendEntrance) return;
  const style = document.createElement('style');
  style.id = 'friend-entrance-style';
  style.textContent = `
    #mchose-friend-page{transition:opacity 200ms cubic-bezier(.23,1,.32,1)}
    html.friend-inline-entering #mchose-friend-page{opacity:0;pointer-events:none}
    #friend-entrance{position:fixed;inset:0;z-index:105;pointer-events:none;color:var(--du-on-l-c2,rgba(0,0,0,.9));font:14px MiSans,"Microsoft YaHei",sans-serif;opacity:1;transition:opacity 200ms cubic-bezier(.23,1,.32,1)}
    #friend-entrance[data-phase=complete]{opacity:0}
    .friend-entrance-avatar{position:absolute;left:calc(50% - 96px);top:calc(50% - 104px);width:192px;height:208px;background-repeat:no-repeat;background-size:1536px 1872px;transform-origin:0 0;opacity:0}
    .friend-entrance-meta{position:absolute;left:50%;top:calc(50% + 120px);transform:translateX(-50%);text-align:center;max-width:calc(100% - 48px);width:280px;opacity:1;transition:opacity 160ms cubic-bezier(.23,1,.32,1)}
    #friend-entrance[data-phase=landing] .friend-entrance-meta{opacity:0}
    .friend-entrance-label{margin:0;line-height:22px;font-size:13px;color:var(--du-on-l-c4,rgba(0,0,0,.6))}
    .friend-entrance-progress{position:relative;overflow:hidden;width:128px;height:3px;border-radius:3px;background:rgba(0,0,0,.08);margin:14px auto 0}
    .friend-entrance-progress span{display:block;width:48px;height:100%;border-radius:3px;background:rgba(0,0,0,.55);animation:friend-entrance-wait 1000ms linear infinite}
    .friend-entrance-retry{pointer-events:auto;margin-top:16px;border:1px solid rgba(255,255,255,.6);border-radius:36px;background:rgba(255,255,255,.5);color:inherit;font:inherit;padding:9px 24px;cursor:pointer}
    .friend-entrance-retry:focus-visible{outline:2px solid #0057ff;outline-offset:3px}
    .friend-entrance-retry[hidden],.friend-entrance-progress[hidden]{display:none}
    @keyframes friend-entrance-wait{from{transform:translateX(-48px)}to{transform:translateX(128px)}}
    @media(prefers-reduced-motion:reduce){#mchose-friend-page,#friend-entrance{transition-duration:120ms}.friend-entrance-progress span{animation:none;transform:translateX(40px)}}
  `;
  document.head.append(style);
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let run = null;
  function notify() {
    const frame = document.getElementById('mchose-friend-page');
    if (run && frame) frame.contentWindow.postMessage({friendUI:token,channel:'friend:opened',payload:{epoch:run.epoch}},'mchose-friend://ui');
  }
  function cleanup() {
    if (!run) return;
    clearTimeout(run.timeout);clearTimeout(run.delay);clearTimeout(run.finish);
    run.animations.forEach(animation => animation.cancel());
    if (run.image) run.image.onload = run.image.onerror = null;
    run.node.remove();run = null;
  }
  function cancel() {
    cleanup();document.documentElement.classList.remove('friend-inline-entering');
    const frame = document.getElementById('mchose-friend-page');if(frame){frame.inert=false;frame.style.removeProperty('transition');}
  }
  function reveal(current) {
    if (run !== current) return;
    document.documentElement.classList.remove('friend-inline-entering');
    const frame = document.getElementById('mchose-friend-page');if(frame){frame.inert=false;frame.style.removeProperty('transition');}
    current.node.dataset.phase='complete';
    current.finish=setTimeout(()=>{if(run===current)cleanup();},preference.matches?120:200);
  }
  async function land(current) {
    if (run !== current || !current.ready || !current.imageReady || current.phase !== 'loading') return;
    current.phase='landing';clearTimeout(current.timeout);current.node.dataset.phase='landing';
    const frame=document.getElementById('mchose-friend-page'),rect=current.rect;
    const valid=rect&&['left','top','width','height'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0&&rect.width<innerWidth&&rect.height<innerHeight&&rect.left>=0&&rect.top>=0;
    if (!preference.matches && valid && frame && !current.avatar.hidden) {
      const first=current.avatar.getBoundingClientRect(),viewport=frame.getBoundingClientRect();
      const transform='translate('+(viewport.left+rect.left-first.left)+'px,'+(viewport.top+rect.top-first.top)+'px) scale('+(rect.width/first.width)+','+(rect.height/first.height)+')';
      // MHUB 2.0 HomeMagicMoveHost uses this exact 560ms curve for the image handoff.
      const animation=current.avatar.animate([{transform:'none'},{transform}],{duration:560,easing:'cubic-bezier(0.43, 0.77, 0.16, 1)',fill:'forwards'});
      current.animations.push(animation);
      try {await animation.finished;} catch (_) {return;}
    }
    reveal(current);
  }
  function advance(current) {
    if(run!==current||!current.ready||!current.imageReady)return;
    if(current.phase==='error'){current.phase='loading';current.node.dataset.phase='loading';current.node.querySelector('button').hidden=true;}
    clearTimeout(current.delay);
    const remaining=preference.matches?0:Math.max(0,180-(performance.now()-(current.arrived||current.started)));
    current.delay=setTimeout(()=>land(current),remaining);
  }
  function start(pet,epoch,waitForLoad) {
    cancel();const frame=document.getElementById('mchose-friend-page');if(!frame)return;
    frame.style.transition='none';document.documentElement.classList.add('friend-inline-entering');frame.inert=true;
    const english=pet&&pet.locale==='en',node=document.createElement('div');node.id='friend-entrance';node.dataset.phase='loading';node.setAttribute('role','status');node.setAttribute('aria-live','polite');
    const avatar=document.createElement('div');avatar.className='friend-entrance-avatar';avatar.setAttribute('aria-hidden','true');
    const meta=document.createElement('div');meta.className='friend-entrance-meta';
    const label=document.createElement('p');label.className='friend-entrance-label';label.textContent=english?'Loading Friends…':'正在加载 Friends…';
    const progress=document.createElement('div');progress.className='friend-entrance-progress';progress.setAttribute('aria-hidden','true');progress.append(document.createElement('span'));
    const retry=document.createElement('button');retry.type='button';retry.className='friend-entrance-retry';retry.textContent=english?'Try again':'重新加载';retry.hidden=true;
    meta.append(label,progress,retry);node.append(avatar,meta);document.body.append(node);
    const current=run={node,avatar,pet,epoch,started:performance.now(),phase:'loading',ready:false,imageReady:false,rect:null,animations:[]};
    function loadImage(url,fallback) {
      if(!url){avatar.hidden=true;current.imageReady=true;advance(current);return;}
      const image=new Image();current.image=image;
      image.onload=()=>{if(run!==current)return;avatar.style.backgroundImage='url('+JSON.stringify(url)+')';current.imageReady=true;current.arrived=performance.now();
        const animation=avatar.animate(preference.matches?[{opacity:0},{opacity:1}]:[{opacity:0,transform:'scale(.96)'},{opacity:1,transform:'none'}],{duration:preference.matches?120:180,easing:'cubic-bezier(.23,1,.32,1)',fill:'forwards'});
        current.animations.push(animation);avatar.style.opacity='1';advance(current);};
      image.onerror=()=>{if(run!==current)return;loadImage(fallback,null);};image.src=url;
    }
    loadImage(pet&&pet.atlasUrl,pet&&pet.fallbackAtlasUrl);
    current.timeout=setTimeout(()=>{
      if(run!==current||current.phase!=='loading')return;
      node.dataset.phase=current.phase='error';progress.hidden=true;label.textContent=english?'Loading is taking longer. Try again or use Back.':'加载时间较长，可重新加载或点击左上角返回。';retry.hidden=false;
    },8000);
    retry.onclick=()=>{if(run!==current)return;const next=current.epoch+':retry';start(pet,next,true);const url=new URL(frame.src);url.searchParams.set('entry',next);frame.src=url.href;};
    if(!waitForLoad)notify();
  }
  function ready(payload) {
    if(!run||!payload||payload.epoch!==run.epoch)return;
    const current=run;if(current.phase==='error'){current.phase='loading';current.node.dataset.phase='loading';current.node.querySelector('button').hidden=true;}
    current.ready=true;current.rect=payload.rect;advance(current);
  }
  function reduceChanged(){if(preference.matches&&run&&run.phase==='landing')reveal(run);}
  function resized(){if(run&&run.phase==='landing')reveal(run);}
  preference.addEventListener('change',reduceChanged);
  window.addEventListener('resize',resized);
  window.__friendEntrance={start,ready,cancel,notify,dispose(){cancel();preference.removeEventListener('change',reduceChanged);window.removeEventListener('resize',resized);style.remove();delete window.__friendEntrance;}};
  document.getElementById('mchose-friend-page')?.addEventListener('load',notify);
}
module.exports={installEntrance};

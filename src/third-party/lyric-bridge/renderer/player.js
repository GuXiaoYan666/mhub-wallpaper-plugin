(function () {
  'use strict';
  var W = window, D = document;
  if (W.__mcPlayer && W.__mcPlayer.dispose) W.__mcPlayer.dispose();
  var snapshot = null, card = null, refs = null, media = null, dragKey = null, dragValue = null, pendingSeek = null, localBusy = 0, disposed = false, coverSrc = '', lastTitle = '', lastArtist = '', lastMessage = '';
  var icons = {
    previous: '<path d="M6 5v14M18 5l-9 7 9 7z"/>',
    next: '<path d="M18 5v14M6 5l9 7-9 7z"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    music: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>'
  };
  function svg(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">'+icons[name]+'</svg>'; }
  var style = D.createElement('style'); style.dataset.mcPlugin = 'mini-style';
  style.textContent = [
    '.mc-mini{margin-top:8px;padding:12px 6px 4px;border-top:1px solid rgba(127,127,127,.16);color:inherit;min-width:0}',
    '.mc-mini-meta{display:flex;gap:11px;align-items:center;min-width:0}',
    '.mc-mini-cover{width:44px;height:44px;flex:none;position:relative;display:grid;place-items:center;border:1px solid rgba(127,127,127,.16);border-radius:10px;background:linear-gradient(140deg,rgba(127,127,127,.2),rgba(127,127,127,.06) 55%,rgba(127,127,127,.15));overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)}',
    '.mc-mini-cover img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}',
    '.mc-mini-cover svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.5;opacity:.5}',
    '.mc-mini-copy{min-width:0;flex:1}.mc-mini-song,.mc-mini-artist{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mc-mini-song{font-size:13px;font-weight:600;line-height:19px;letter-spacing:.01em}.mc-mini-artist{font-size:11px;line-height:17px;opacity:.58}',
    '.mc-mini-timeline{margin-top:11px}',
    '.mc-mini-controls{display:grid;grid-template-columns:32px 36px 32px;align-items:center;justify-content:center;gap:18px;margin:2px 0 0}',
    '.mc-mini-button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:50%;padding:7px;background:transparent;color:inherit;cursor:pointer;opacity:.78;transition:opacity .15s,background .15s}',
    '.mc-mini-button svg{width:17px;height:17px;fill:currentColor;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round}',
    '.mc-mini-button[data-action=toggle]{width:36px;height:36px;padding:9px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.06);opacity:1;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
    '.mc-mini-button[data-playing=true] svg{fill:none;stroke-width:2.6}',
    '.mc-mini-button:hover:enabled{opacity:1;background:rgba(127,127,127,.12)}',
    '.mc-mini-button:active:enabled{background:rgba(127,127,127,.18)}',
    '.mc-mini-button:disabled{opacity:.28;cursor:default}',
    '.mc-mini-button:focus-visible,.mc-mini-range:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    '.mc-mini-progress{position:relative;isolation:isolate;height:16px;--mc-progress:0%}',
    '.mc-mini-track,.mc-mini-fill{position:absolute;top:6.5px;left:0;height:3px;border-radius:2px;pointer-events:none}',
    '.mc-mini-track{width:100%;background:rgba(127,127,127,.22)}',
    '.mc-mini-fill{width:var(--mc-progress);background:currentColor;opacity:.78;transition:width .24s linear}',
    '.mc-mini-progress[data-playing=false] .mc-mini-fill{opacity:.42}',
    '.mc-mini[data-dragging=true] .mc-mini-fill{transition:none}',
    '.mc-mini-range{position:absolute;inset:0;width:100%;height:16px;margin:0;padding:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer;z-index:1}',
    '.mc-mini-range::-webkit-slider-runnable-track{height:3px;background:transparent}',
    '.mc-mini-range::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:10px;height:10px;margin-top:-3.5px;border:0;border-radius:50%;background:currentColor;box-shadow:0 0 0 2px rgba(255,255,255,.92);opacity:0;transition:opacity .15s}',
    '.mc-mini-progress:hover .mc-mini-range::-webkit-slider-thumb,.mc-mini-range:focus-visible::-webkit-slider-thumb,.mc-mini-range:active::-webkit-slider-thumb{opacity:1}',
    '.mc-mini-range:disabled{cursor:default}.mc-mini-range:disabled::-webkit-slider-thumb{opacity:0}',
    '.mc-mini-progress[data-seekable=false]{opacity:.4}',
    '.mc-mini-times{display:flex;align-items:center;justify-content:space-between;font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums;opacity:.55}',
    '.mc-mini-message{font-size:11px;line-height:16px;margin:5px 0 0;color:inherit;opacity:.7}.mc-mini-message:empty{display:none}',
    '.mc-mini[data-empty=true] .mc-mini-fill{opacity:.3}.mc-mini[data-empty=true] .mc-mini-song{font-weight:500}',
    'html[theme-mode=dark] .mc-mini{border-color:rgba(255,255,255,.14)}',
    'html[theme-mode=dark] .mc-mini-cover{border-color:rgba(255,255,255,.16)}',
    'html[theme-mode=dark] .mc-mini-track{background:rgba(255,255,255,.22)}',
    'html[theme-mode=dark] .mc-mini-button[data-action=toggle]{border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.06)}',
    'html[theme-mode=dark] .mc-mini-button:hover:enabled{background:rgba(255,255,255,.1)}',
    'html[theme-mode=dark] .mc-mini-range::-webkit-slider-thumb{box-shadow:0 0 0 2px rgba(24,24,27,.92)}',
    '@media(prefers-reduced-motion:reduce){.mc-mini-fill{transition:none}.mc-mini-button{transition:none}}',
    '.mc-player-panel:has(.mc-mini){margin-bottom:16px}',
    '.audio-detail-sidebar:has(.mc-mini){overflow-y:auto;scrollbar-width:thin;padding-bottom:44px;scroll-padding-bottom:52px}',
    '.audio-detail-sidebar__scroll:has(.mc-mini){min-height:0;padding-bottom:12px;scroll-padding-bottom:52px}',
    '@media(max-height:850px){.mc-player-panel:has(.mc-mini){padding-top:14px}.mc-player-panel:has(.mc-mini) .mc-player-heading{margin-bottom:12px}.mc-player-panel:has(.mc-mini) .mc-player-cell{padding-top:8px;padding-bottom:8px;gap:4px}.mc-player-panel:has(.mc-mini) .mc-player-note{margin-top:8px}}',
    '@media(forced-colors:active){.mc-mini-track{background:GrayText}.mc-mini-fill{background:Highlight}.mc-mini-range::-webkit-slider-thumb{background:Highlight;box-shadow:none}}'
  ].join('\n');
  D.head.appendChild(style);
  function format(ms) {
    var seconds = Math.max(0,Math.floor((Number(ms)||0)/1000));
    return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  }
  function issue(action, extra) {
    if (!media || Date.now()-localBusy<700) return false;
    var m = media;
    localBusy = Date.now();
    W.__mcBridgeHost.send(Object.assign({t:'mediaControl',action:action,sessionId:m.id,trackKey:m.key},extra||{}));
    paint();
    return true;
  }
  function mount() {
    if (card && card.isConnected) return;
    var panel = D.querySelector('[data-mc-plugin="player-panel"]');
    if (!panel) { if(card)card.remove();card=null;refs=null;return; }
    if(card)card.remove();
    card = D.createElement('section'); card.dataset.mcPlugin='mini-player';card.className='mc-mini';card.setAttribute('aria-label','当前播放');
    card.innerHTML = '<div class="mc-mini-meta"><div class="mc-mini-cover">'+svg('music')+'<img alt="专辑封面" hidden decoding="async"></div><div class="mc-mini-copy"><p class="mc-mini-song"></p><p class="mc-mini-artist"></p></div></div>'+
      '<div class="mc-mini-timeline"><div class="mc-mini-progress"><div class="mc-mini-track"></div><div class="mc-mini-fill"></div><input type="range" class="mc-mini-range" aria-label="播放进度" min="0" max="1000" step="1" value="0"></div><div class="mc-mini-times"><span data-time="elapsed">0:00</span><span data-time="duration">--:--</span></div></div>'+
      '<div class="mc-mini-controls"><button type="button" class="mc-mini-button" data-action="previous" aria-label="上一首" title="上一首">'+svg('previous')+'</button><button type="button" class="mc-mini-button" data-action="toggle" aria-label="播放" title="播放">'+svg('play')+'</button><button type="button" class="mc-mini-button" data-action="next" aria-label="下一首" title="下一首">'+svg('next')+'</button></div><p class="mc-mini-message" role="status" aria-live="polite"></p>';
    refs = {
      song: card.querySelector('.mc-mini-song'), artist: card.querySelector('.mc-mini-artist'),
      image: card.querySelector('img'), range: card.querySelector('input'),
      progress: card.querySelector('.mc-mini-progress'), elapsed: card.querySelector('[data-time=elapsed]'),
      duration: card.querySelector('[data-time=duration]'), play: card.querySelector('[data-action=toggle]'),
      note: card.querySelector('.mc-mini-message'), buttons: Array.prototype.slice.call(card.querySelectorAll('button'))
    };
    refs.buttons.forEach(function(b){b.onclick=function(){issue(b.dataset.action);};});
    var range=refs.range;
    function setDrag(on){ card.dataset.dragging=String(on); }
    range.addEventListener('pointerdown',function(){if(!media||range.disabled)return;dragKey=media.key;dragValue=Number(range.value);setDrag(true);});
    range.addEventListener('pointercancel',function(){dragKey=null;dragValue=null;setDrag(false);paintProgress();});
    range.addEventListener('input',function(){if(!media)return;dragKey=media.key;dragValue=Number(range.value);setDrag(true);paintProgress();});
    range.addEventListener('change',function(){
      var key=dragKey,value=dragValue;dragKey=null;dragValue=null;setDrag(false);
      if(media&&key===media.key&&Number.isFinite(value)) {
        var target=Math.round(value/1000*media.durationMs);
        pendingSeek={key:key,positionMs:target,at:Date.now()};
        if(!issue('seek',{positionMs:target,durationMs:media.durationMs}))pendingSeek=null;
      }
      paintProgress();
    });
    range.addEventListener('keydown',function(e){if(e.key==='Escape'){dragKey=null;dragValue=null;setDrag(false);range.blur();paintProgress();}});
    panel.appendChild(card);coverSrc='';lastTitle='';lastArtist='';lastMessage='';
  }
  function paintProgress() {
    if(!card||!refs)return;
    var duration=media?media.durationMs:0;
    var pos=media?media.positionMs+(media.playing?Math.max(0,Math.min(1500,Date.now()-media.at)):0):0;
    if(pendingSeek&&media&&pendingSeek.key===media.key){
      var action=snapshot&&snapshot.nowPlaying&&snapshot.nowPlaying.action;
      if(Date.now()-pendingSeek.at>6500||Math.abs(pos-pendingSeek.positionMs)<1200||action&&action.phase==='error'&&action.at>=pendingSeek.at)pendingSeek=null;
      else pos=pendingSeek.positionMs;
    }
    if(dragKey&&media&&dragKey===media.key)pos=dragValue/1000*duration;
    pos=Math.max(0,Math.min(duration,pos));
    var progress=duration>0?pos/duration*100:0;
    var value=Math.round(progress*10);
    if(!dragKey&&Number(refs.range.value)!==value)refs.range.value=String(value);
    refs.progress.style.setProperty('--mc-progress',progress.toFixed(2)+'%');
    var playing=String(!!(media&&media.playing));
    if(refs.progress.dataset.playing!==playing)refs.progress.dataset.playing=playing;
    var aria=format(pos)+' / '+(duration?format(duration):'未知时长');
    if(refs.range.getAttribute('aria-valuetext')!==aria)refs.range.setAttribute('aria-valuetext',aria);
    var elapsed=format(pos),total=duration?format(duration):'--:--';
    if(refs.elapsed.textContent!==elapsed)refs.elapsed.textContent=elapsed;
    if(refs.duration.textContent!==total)refs.duration.textContent=total;
  }
  function paint() {
    if(disposed||D.hidden)return;
    mount();if(!card||!refs)return;
    var state=snapshot&&snapshot.nowPlaying;
    var previous=media;media=state&&state.media||null;
    if(media&&Date.now()-media.at>5000)media=null;
    if(!media||previous&&previous.key!==media.key){dragKey=null;dragValue=null;pendingSeek=null;}
    var busy=Date.now()-localBusy<700||!!(state&&state.action&&state.action.phase==='pending');
    var empty=String(!media);
    if(card.dataset.empty!==empty)card.dataset.empty=empty;
    var title=media?media.title:state&&!state.ready?'正在连接播放器…':'暂无播放';
    var artist;
    if(media){
      var parts=[];
      if(media.artist)parts.push(media.artist);
      if(media.album)parts.push(media.album);
      artist=parts.length?parts.join(' · '):'未知歌手';
    }else artist='在上方播放器中播放音乐';
    if(lastTitle!==title){refs.song.textContent=title;refs.song.title=title;lastTitle=title;}
    if(lastArtist!==artist){refs.artist.textContent=artist;refs.artist.title=artist;lastArtist=artist;}
    var src=media&&media.artwork||'';
    if(src!==coverSrc){
      coverSrc=src;refs.image.hidden=true;refs.image.removeAttribute('src');
      refs.image.onload=function(){if(src===coverSrc&&this.getAttribute('src')===src&&this.complete&&this.naturalWidth>0)this.hidden=false;};
      refs.image.onerror=function(){if(src===coverSrc)this.hidden=true;};
      if(src)refs.image.src=src;else refs.image.removeAttribute('src');
    }
    var playing=!!(media&&media.playing),label=playing?'暂停':'播放';
    if(refs.play.getAttribute('aria-label')!==label){refs.play.innerHTML=svg(playing?'pause':'play');refs.play.setAttribute('aria-label',label);refs.play.title=label;}
    refs.play.dataset.playing=String(playing);
    var controls=media&&media.controls||{};
    refs.buttons.forEach(function(b){b.disabled=busy||!media||!controls[b.dataset.action==='toggle'?'playPause':b.dataset.action];});
    refs.range.disabled=busy||!media||!controls.seek||media.durationMs<=0;
    var seekable=String(!!(media&&controls.seek&&media.durationMs>0));
    if(refs.progress.dataset.seekable!==seekable)refs.progress.dataset.seekable=seekable;
    var action=state&&state.action;
    var message=action&&action.phase==='error'&&action.trackKey===(media&&media.key)&&Date.now()-action.at<8000?action.message:state&&state.error?'播放器连接中断，正在重连':'';
    if(lastMessage!==message){refs.note.textContent=message;lastMessage=message;}
    paintProgress();
  }
  var unsubscribe=W.__mcBridgeHost.onSnapshot(function(s){snapshot=s;paint();});
  var timer=W.setInterval(paint,250);
  W.__mcPlayer={inspect:function(){return{mounted:!!(card&&card.isConnected),media:media&&{id:media.id,key:media.key,title:media.title,playing:media.playing},dragging:!!dragKey};},dispose:function(){disposed=true;unsubscribe();W.clearInterval(timer);if(card)card.remove();style.remove();}};
  paint();
})();

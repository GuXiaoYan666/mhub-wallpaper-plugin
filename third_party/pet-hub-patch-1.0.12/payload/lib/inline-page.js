'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {pathToFileURL,fileURLToPath}=require('url');
const IPC=require('./ipc.js');
const {installEntrance}=require('./page-transition.js');
const SCHEME='mchose-friend',PREFIX='__FRIEND_UI__';
const ROOT=path.resolve(__dirname,'..');
const allowed=new Set(['GET_STATE','UPDATE','RESET_POSITION','CLOSE','PLAY','PREVIEW_LEVELUP','SELECT','DELETE','IMPORT','IMPORT_CANCEL','QUALITY_RETRY','DIAGNOSTICS','RECONNECT','MANAGE'].map(k=>IPC[k]));
allowed.add('friend:modal');
allowed.add('friend:ready');
function registerScheme(electron){electron.protocol.registerSchemesAsPrivileged([{scheme:SCHEME,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);}
function contained(root,file){const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}
function installProtocol(electron){
  if(!electron.protocol||typeof electron.protocol.handle!=='function')return false;
  electron.protocol.handle(SCHEME,async request=>{
    try{
      const url=new URL(request.url);if(url.hostname!=='ui')return new Response('',{status:403});
      const relative=decodeURIComponent(url.pathname).replace(/^\//,'');
      if(relative==='modules.js'){
        const wrap=(name,file)=>'window.'+name+'=(()=>{const module={exports:{}};'+fs.readFileSync(path.join(ROOT,file),'utf8')+';return module.exports;})();';
        return new Response(wrap('FriendIPC','lib/ipc.js')+wrap('FriendI18n','renderer/settings/i18n.js'),{headers:{'Content-Type':'text/javascript'}});
      }
      if(relative.split(/[\\/]/).some(part=>part==='..'||part==='.'))return new Response('',{status:403});
      const permitted=/^(?:renderer\/settings\/|shared\/(?:actions|quality)\.js$|renderer\/pet\/pet-hd\.js$)/.test(relative)||/^pets\/.+\.(?:png|webp|jpe?g|gif)$/i.test(relative);
      const file=path.resolve(ROOT,relative);if(!permitted||!contained(ROOT,file))return new Response('',{status:403});
      const actual=await fs.promises.realpath(file);if(!contained(ROOT,actual))return new Response('',{status:403});
      let data=await fs.promises.readFile(actual);const ext=path.extname(file).toLowerCase();
      if(relative==='renderer/settings/index.html') data=Buffer.from(data.toString('utf8').replace('<script src="../../shared/actions.js">','<script src="/modules.js"></script><script src="web-adapter.js"></script><script src="../../shared/actions.js">').replace('<body>','<body data-inline="true">'));
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
      return new Response(data,{headers:{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'}});
    }catch(_){return new Response('',{status:404});}
  });
}
function publicState(value){
  if(typeof value==='string'&&value.startsWith('file:')){try{const file=fileURLToPath(value);return contained(ROOT,file)?SCHEME+'://ui/'+path.relative(ROOT,file).split(path.sep).map(encodeURIComponent).join('/'):'';}catch(_){return '';}}
  if(Array.isArray(value))return value.map(publicState);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,publicState(v)]));
  return value;
}
function mountPage(token,url,epoch){
  document.documentElement.classList.add('friend-inline-open');
  if(!document.getElementById('friend-inline-host-style')){const style=document.createElement('style');style.id='friend-inline-host-style';style.textContent='html.friend-inline-open .connect-device > :not(.app-header):not(.connect-device__backgrounds),html.friend-inline-open #app > .transform-gif,html.friend-inline-open #app > .gif3d-box{visibility:hidden!important;pointer-events:none!important}';document.head.append(style);}
  let frame=document.getElementById('mchose-friend-page');
  if(!frame){frame=document.createElement('iframe');frame.id='mchose-friend-page';frame.title='Friends';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.style.cssText='position:fixed;left:0;right:0;bottom:0;width:100%;border:0;background:transparent;z-index:100;display:block;color-scheme:light;';frame.src=url+'?token='+token+'&entry='+encodeURIComponent(epoch);document.body.append(frame);}
  const headers=Array.from(document.querySelectorAll('.app-header')).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');const top=headers.length?headers[0].getBoundingClientRect().bottom:80;
  if(!window.__friendInlineHidden&&headers[0]){
    window.__friendInlineHidden=[];
    for(const element of headers[0].parentElement.children){
      if(element===headers[0]||/background|wallpaper/.test(element.className)||element.tagName==='STYLE')continue;
      window.__friendInlineHidden.push({element,inert:element.inert,value:element.style.getPropertyValue('visibility'),priority:element.style.getPropertyPriority('visibility')});
      element.style.setProperty('visibility','hidden','important');element.inert=true;
    }
  }
  frame.style.top=top+'px';frame.style.height='calc(100% - '+top+'px)';frame.hidden=false;frame.style.display='block';
  let shade=document.getElementById('friend-header-shade');if(!shade){shade=document.createElement('div');shade.id='friend-header-shade';shade.style.cssText='position:fixed;inset:0 0 auto;z-index:110;background:rgba(17,24,39,.35);display:none;';document.body.append(shade);}shade.style.height=top+'px';
  frame.focus();return true;
}
function transport(token,prefix){
  const key='__friendInlineTransport';if(window[key])window.removeEventListener('message',window[key]);
  window[key]=event=>{const frame=document.getElementById('mchose-friend-page'),data=event.data;
    if(!frame||event.source!==frame.contentWindow||event.origin!=='mchose-friend://ui'||!data||data.friendUI!==token||!Number.isSafeInteger(data.id)||typeof data.channel!=='string')return;
    const text=JSON.stringify({id:data.id,channel:data.channel,payload:data.payload});if(text.length>256000)return;console.log(prefix+token+' '+text);
  };window.addEventListener('message',window[key]);
}
function createInlinePage(options){
  const fallback=options.fallback,token=crypto.randomBytes(16).toString('hex');let host=null,opened=false,active=false,sender=null,listener=null,navigation=null,generation=0,mountedGeneration=0;
  function script(code){const c=host&&host.webContents;if(!c||c.isDestroyed())return Promise.resolve(null);return c.executeJavaScript(code,true).catch(()=>null);}
  function post(data){return script('(()=>{const f=document.getElementById("mchose-friend-page");if(f)f.contentWindow.postMessage('+JSON.stringify({...data,friendUI:token})+',"mchose-friend://ui");})()');}
  function wire(target){
    if(host===target&&listener)return;
    if(host&&listener)host.webContents.removeListener('console-message',listener);if(host&&navigation)host.webContents.removeListener('did-navigate-in-page',navigation);host=target;
    sender={id:host.webContents.id,getURL:()=>pathToFileURL(path.join(ROOT,'renderer/settings/index.html')).href,isDestroyed:()=>!host||host.webContents.isDestroyed(),send:(channel,payload)=>send(channel,payload)};
    listener=async(event,_level,message)=>{const text=typeof message==='string'?message:event&&event.message;const start=PREFIX+token+' ';if(!active||!text||!text.startsWith(start))return;
      let request;try{request=JSON.parse(text.slice(start.length));if(!Number.isSafeInteger(request.id)||!allowed.has(request.channel))return;
        let result;if(request.channel==='friend:ready'){if(opened)await script('window.__friendEntrance?.ready('+JSON.stringify(request.payload)+')');result=true;}
        else if(request.channel==='friend:modal'){const visible=request.payload===true;await script('(()=>{const s=document.getElementById("friend-header-shade");if(s)s.style.display='+JSON.stringify(visible?'block':'none')+';})()');result=true;}else result=await options.dispatch(request.channel,{sender},request.payload);
        await post({reply:request.id,result:publicState(result)});}catch(_){if(request)await post({reply:request.id,error:'unavailable'});}
    };host.webContents.on('console-message',listener);navigation=(_event,_url,isMainFrame)=>{if(isMainFrame!==false&&opened)close();};host.webContents.on('did-navigate-in-page',navigation);
  }
  function open(target){
    if(opened&&host===target)return {inline:true};
    if(!/mchose-renderer:\/\/app\//.test(target.webContents.getURL())){active=false;return fallback.open(target);}
    wire(target);opened=true;const ticket=++generation;host.show();host.focus();
    const c=host.webContents;
    c.executeJavaScript('Boolean(document.querySelector(".app-header"))').then(modern=>{
      if(!opened||ticket!==generation)return;if(!modern){active=false;fallback.open(target);return;}active=true;
      const pet=publicState(options.getTransitionPet?options.getTransitionPet():null),epoch=ticket+':0';
      return Promise.resolve(c.executeJavaScriptInIsolatedWorld(1099,[{code:'('+transport.toString()+')('+JSON.stringify(token)+','+JSON.stringify(PREFIX)+')'}])).then(()=>{
        if(!opened||ticket!==generation)return;
        return script('('+mountPage.toString()+')('+JSON.stringify(token)+',"mchose-friend://ui/renderer/settings/index.html",'+JSON.stringify(epoch)+');('+installEntrance.toString()+')('+JSON.stringify(token)+');window.__friendEntrance.start('+JSON.stringify(pet)+','+JSON.stringify(epoch)+');').then(()=>{if(opened&&ticket===generation)mountedGeneration=ticket;});
      });
    }).catch(()=>{if(opened&&ticket===generation){active=false;fallback.open(target);}});
    return {inline:true};
  }
  function close(){opened=false;generation++;if(!active)return fallback.close();script('(()=>{window.__friendEntrance?.cancel();document.documentElement.classList.remove("friend-inline-open");for(const old of window.__friendInlineHidden||[]){old.element.style.setProperty("visibility",old.value,old.priority);old.element.inert=old.inert;}delete window.__friendInlineHidden;const f=document.getElementById("mchose-friend-page");if(f)f.style.display="none";const s=document.getElementById("friend-header-shade");if(s)s.style.display="none";})()');if(options.onClose)options.onClose(host);return true;}
  function send(channel,payload){if(!active)return fallback.send(channel,payload);post({channel,payload:publicState(payload)});return true;}
  function fit(){if(!active)return fallback.fit();if(opened&&mountedGeneration===generation)script('('+mountPage.toString()+')('+JSON.stringify(token)+',"mchose-friend://ui/renderer/settings/index.html")');return true;}
  function setVisible(value){if(!active)return fallback.setVisible(value);script('(()=>{const f=document.getElementById("mchose-friend-page");if(f)f.style.visibility='+JSON.stringify(value?'visible':'hidden')+';})()');return true;}
  return {open,close,send,fit,setVisible,isOpen:()=>active?opened:fallback.isOpen(),dispose(){close();if(host&&listener)host.webContents.removeListener('console-message',listener);if(host&&navigation)host.webContents.removeListener('did-navigate-in-page',navigation);script('window.__friendEntrance?.dispose();document.getElementById("mchose-friend-page")?.remove()');fallback.dispose();}};
}
module.exports={registerScheme,installProtocol,createInlinePage,publicState,contained};

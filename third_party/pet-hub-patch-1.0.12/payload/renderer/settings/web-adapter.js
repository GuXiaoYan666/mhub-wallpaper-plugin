(function(){
  'use strict';
  const params=new URLSearchParams(location.search),token=params.get('token'),pending=new Map(),listeners=new Map();let sequence=0,entryEpoch=params.get('entry'),readyElement,hasReady=false,lastReady='';
  const ipcRenderer={
    invoke(channel,payload){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('request timed out'));},600000);pending.set(id,{resolve,reject,timer});parent.postMessage({friendUI:token,id,channel,payload},'mchose-renderer://app');});},
    send(channel,payload){this.invoke(channel,payload).catch(()=>{});},
    on(channel,callback){if(!listeners.has(channel))listeners.set(channel,new Set());listeners.get(channel).add(callback);return this;},
    removeListener(channel,callback){listeners.get(channel)?.delete(callback);return this;}
  };
  window.addEventListener('message',event=>{const data=event.data;if(event.source!==parent||event.origin!=='mchose-renderer://app'||!data||data.friendUI!==token)return;
    if(data.reply){const request=pending.get(data.reply);if(!request)return;clearTimeout(request.timer);pending.delete(data.reply);data.error?request.reject(Error(data.error)):request.resolve(data.result);}
    else if(data.channel==='friend:opened'){entryEpoch=data.payload&&data.payload.epoch;reportModal(true);reportReady();}
    else if(data.channel)listeners.get(data.channel)?.forEach(fn=>fn({},data.payload));
  });
  window.require=id=>{if(id==='electron')return {ipcRenderer};if(id==='../../lib/ipc.js')return window.FriendIPC;if(id==='./i18n.js')return window.FriendI18n;throw Error('Module unavailable');};
  function reportReady(){
    if(!hasReady||!entryEpoch)return;
    const bounds=readyElement&&readyElement.getBoundingClientRect(),rect=bounds?{left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height}:null;
    const payload={epoch:entryEpoch,rect},key=JSON.stringify(payload);if(key===lastReady)return;lastReady=key;
    ipcRenderer.invoke('friend:ready',payload).catch(()=>{lastReady='';});
  }
  window.FriendEntrance={ready(element){hasReady=true;readyElement=element;reportReady();}};
  window.addEventListener('resize',reportReady);
  let modalOpen=null;
  function reportModal(force){const open=!!document.querySelector('.dialog-backdrop[data-open]');if(force||open!==modalOpen){modalOpen=open;ipcRenderer.invoke('friend:modal',open).catch(()=>{});}}
  new MutationObserver(()=>reportModal(false)).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-open']});reportModal(false);
  window.addEventListener('beforeunload',()=>{pending.forEach(r=>{clearTimeout(r.timer);r.reject(Error('page closed'));});pending.clear();});
})();

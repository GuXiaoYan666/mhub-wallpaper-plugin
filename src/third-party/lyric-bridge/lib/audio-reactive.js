'use strict';
const path = require('path');
const {spawn} = require('child_process');
function createAudioReactive(options = {}) {
  const now=options.now||Date.now, changed=options.onChange||(()=>{});
  let wanted=false, child=null, buffer='', retry=null, watchdog=null, received=0, session=0, state={ready:false,source:'default-output'};
  function emit(value){state=value;try{changed(value);}catch(_){}}
  function scheduleRetry(){
    if(!wanted||retry)return;
    retry=setTimeout(()=>{retry=null;launch();},options.retryMs||2500);retry.unref?.();
  }
  function launch(){
    if(!wanted||child)return;
    let proc;
    try{proc=(options.spawn||spawn)('powershell.exe',['-Mta','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'audio-reactive.ps1'),'-ParentProcessId',String(process.pid)],{windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch(_){emit({ready:false,source:'default-output',at:now()});scheduleRetry();return;}
    child=proc;session++;buffer='';received=now();
    if(proc.stdout.setEncoding)proc.stdout.setEncoding('utf8');
    proc.stdout.on('data',chunk=>{
      if(child!==proc)return;buffer+=String(chunk);if(buffer.length>32768){buffer='';return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const row=buffer.slice(0,end);buffer=buffer.slice(end+1);try{accept(JSON.parse(row));}catch(_){}}
    });
    proc.stderr.on('data',()=>{});
    const failed=()=>{if(child!==proc)return;child=null;try{proc.kill();}catch(_){}emit({ready:false,source:'default-output',at:now()});scheduleRetry();};
    proc.on('error',failed);proc.on('exit',failed);
  }
  function accept(row){
    if(!row||!wanted)return;
    if(row.t==='spectrum'){
      const keys=['energy','bass','mid','treble','beat'];
      if(!keys.every(k=>Number.isFinite(row[k])&&row[k]>=0&&row[k]<=1)||!Number.isSafeInteger(row.serial)||row.serial<0)return;
      received=now();emit({ready:true,source:'default-output',session,at:received,energy:row.energy,bass:row.bass,mid:row.mid,treble:row.treble,beat:row.beat,serial:row.serial});
    }else if(row.t==='ready')received=now();
    else if(row.t==='error'){emit({ready:false,source:'default-output',at:now()});}
  }
  return {
    setActive(active){
      if(!!active===wanted)return;wanted=!!active;
      if(wanted){launch();watchdog=setInterval(()=>{if(child&&now()-received>6000){const old=child;child=null;try{old.kill();}catch(_){}emit({ready:false,source:'default-output',at:now()});scheduleRetry();}},1000);watchdog.unref?.();}
      else{clearTimeout(retry);retry=null;clearInterval(watchdog);watchdog=null;const old=child;child=null;if(old)old.kill();emit({ready:false,source:'default-output',at:now()});}
    },
    snapshot(){return state.ready&&now()-received<600?state:{ready:false,source:'default-output',at:now()};},
    stop(){this.setActive(false);},
    _accept:accept
  };
}
module.exports={createAudioReactive};

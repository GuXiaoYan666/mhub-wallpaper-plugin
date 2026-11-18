(function(){
  'use strict';
  let previous=null;
  document.addEventListener('pointermove',event=>{
    const control=event.target.closest('button:not(:disabled),.pet-item,.segmented,.hero-tool,.switch');
    if(previous&&previous!==control)previous.classList.remove('is-glowing');previous=control;
    if(!control)return;const box=control.getBoundingClientRect();control.style.setProperty('--glow-x',(event.clientX-box.left)+'px');control.style.setProperty('--glow-y',(event.clientY-box.top)+'px');control.classList.add('is-glowing');
  },{passive:true});
  document.addEventListener('pointerleave',()=>{if(previous)previous.classList.remove('is-glowing');previous=null;});
})();

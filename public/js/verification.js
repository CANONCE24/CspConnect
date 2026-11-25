'use strict';
const resendButton=document.querySelector('[data-resend-code]');
const resendStatus=document.querySelector('[data-resend-status]');
if(resendButton){
  const availableAt=Date.now()+Number(resendButton.dataset.resendSeconds)*1000;
  const update=()=>{
    const seconds=Math.max(0,Math.ceil((availableAt-Date.now())/1000));
    resendButton.disabled=seconds>0;
    resendStatus.textContent=seconds>0?`You can resend in ${seconds} seconds.`:'You can request a new code.';
  };
  update();const timer=setInterval(update,1000);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}

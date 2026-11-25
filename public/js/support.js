'use strict';
document.querySelectorAll('[data-copy-support-email]').forEach(button=>{
  button.addEventListener('click',async()=>{
    const status=button.closest('.support-email').querySelector('[data-copy-support-status]');
    try{await navigator.clipboard.writeText(button.dataset.copySupportEmail);status.textContent='Email address copied.';}
    catch{status.textContent='Select the email address above to copy it, or use Email Administrator.';}
  });
});
document.querySelectorAll('[data-support-form]').forEach(form=>{
  form.addEventListener('submit',()=>{form.querySelector('button[type="submit"]').disabled=true;});
});
window.addEventListener('pageshow',()=>{
  document.querySelectorAll('[data-support-form] button[type="submit"]').forEach(button=>{button.disabled=false;});
});

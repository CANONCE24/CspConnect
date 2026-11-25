'use strict';
document.querySelectorAll('[data-comment-decision]').forEach(form=>{
  let submitting=false;
  form.addEventListener('submit',event=>{
    if(submitting){event.preventDefault();return;}
    if(event.submitter?.value==='remove'){
      if(!window.confirm('Remove this comment from public view? Its text and moderation history will be preserved, and an administrator can restore it.')){event.preventDefault();return;}
      const confirmation=document.createElement('input');confirmation.type='hidden';confirmation.name='confirmed';confirmation.value='1';form.append(confirmation);
    }
    submitting=true;
  });
});

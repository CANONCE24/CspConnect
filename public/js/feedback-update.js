'use strict';
(() => {
  const form = document.querySelector('[data-feedback-update]');
  if (!form) return;
  const templates = JSON.parse(form.dataset.templates);
  const status = form.querySelector('#status'), response = form.querySelector('#response-body');
  const action = form.querySelector('#action-taken'), closure = form.querySelector('#closure-reason');
  const actionCheck = form.querySelector('[name="actionConfirmed"]');
  const dialog = form.querySelector('[data-update-dialog]');
  const submit = form.querySelector('button[type="submit"]');
  const methods = { web: 'Web Only', email: 'Email Only', both: 'Both' };
  let previousStatus = status.value, approved = false, submitting = false;
  const defaultResponse = () => templates[status.value]
    .replace('{{actionTaken}}', () => action.value.trim() || '{{actionTaken}}')
    .replace('{{closureReason}}', () => closure.value.trim() || '{{closureReason}}');
  let lastDefault = defaultResponse();
  const edited = () => response.value !== lastDefault;
  const generate = () => { lastDefault = defaultResponse(); response.value = lastDefault; };
  const fields = () => {
    const resolved = status.value === 'Resolved', closed = status.value === 'Closed';
    form.querySelector('[data-action-fields]').hidden = !resolved;
    form.querySelector('[data-closure-fields]').hidden = !closed;
    action.required = resolved; actionCheck.required = resolved; closure.required = closed;
  };
  fields();
  status.addEventListener('change', () => {
    if (edited() && !window.confirm('Changing status will replace your edited response with the default for the new status. Continue?')) { status.value = previousStatus; return; }
    previousStatus = status.value; fields(); generate();
  });
  [action, closure].forEach(input => input.addEventListener('input', () => { if (!edited()) generate(); }));
  action.addEventListener('input', () => { actionCheck.checked = false; });
  form.querySelector('[data-restore-response]').addEventListener('click', () => {
    if (edited() && !window.confirm('Replace your edited response with the default response?')) return;
    generate();
  });
  form.addEventListener('submit', event => {
    if (submitting) { event.preventDefault(); return; }
    if (approved) { submitting = true; submit.disabled = true; return; }
    event.preventDefault();
    if (/\{\{(?:actionTaken|closureReason)\}\}/.test(response.value)) {
      response.setCustomValidity('Replace the action or closure placeholder with the actual details.');
      response.reportValidity(); response.setCustomValidity(''); return;
    }
    form.querySelector('[data-review-status]').textContent = status.value;
    form.querySelector('[data-review-method]').textContent = methods[form.elements.notificationMethod.value];
    form.querySelector('[data-review-response]').textContent = response.value;
    const details = form.querySelector('[data-review-details]');
    details.hidden = !['Resolved', 'Closed'].includes(status.value);
    details.textContent = status.value === 'Resolved' ? 'Confirmed action taken: ' + action.value : 'Reason for closing: ' + closure.value;
    dialog.showModal();
  });
  form.querySelector('[data-review-cancel]').addEventListener('click', () => dialog.close());
  form.querySelector('[data-review-confirm]').addEventListener('click', () => {
    if (!form.reportValidity()) { dialog.close(); return; }
    const confirmation = document.createElement('input');
    confirmation.type = 'hidden'; confirmation.name = 'confirmed'; confirmation.value = '1'; form.append(confirmation);
    approved = true; dialog.close(); form.requestSubmit(submit);
  });
})();

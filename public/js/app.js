'use strict';

const accountMenu = document.querySelector('[data-account-menu]');
if (accountMenu) {
  document.addEventListener('click', event => {
    if (!accountMenu.contains(event.target)) accountMenu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && accountMenu.open) {
      accountMenu.open = false;
      accountMenu.querySelector('summary').focus();
    }
  });
  accountMenu.addEventListener('focusout', () => {
    window.setTimeout(() => { if (!accountMenu.contains(document.activeElement)) accountMenu.open = false; }, 0);
  });
}

document.querySelectorAll('[data-toggle-password]').forEach(button => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});

const profileForm = document.querySelector('[data-profile-form]');
if (profileForm) {
  const photoInput = profileForm.querySelector('#profile-photo');
  const preview = profileForm.querySelector('[data-photo-preview]');
  const original = preview.cloneNode(true);
  const status = profileForm.querySelector('#photo-status');
  const remove = profileForm.querySelector('[data-remove-photo]');
  let previewUrl;
  const clearPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
    preview.replaceChildren(...[...original.childNodes].map(node => node.cloneNode(true)));
  };
  photoInput.addEventListener('change', () => {
    clearPreview();
    status.textContent = '';
    status.classList.remove('is-error');
    photoInput.setCustomValidity('');
    const file = photoInput.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      status.textContent = 'Choose a JPG, PNG, or WebP image up to 5 MB.';
      status.classList.add('is-error');
      photoInput.setCustomValidity(status.textContent);
      return;
    }
    if (remove) remove.checked = false;
    previewUrl = URL.createObjectURL(file);
    const image = document.createElement('img');
    image.src = previewUrl;
    image.alt = 'Selected profile photo preview';
    const frame = document.createElement('span');
    frame.className = 'profile-avatar avatar-large';
    frame.append(image);
    preview.replaceChildren(frame);
    status.textContent = `${file.name} · Ready to save`;
  });
  remove?.addEventListener('change', () => {
    clearPreview();
    photoInput.value = '';
    photoInput.setCustomValidity('');
    status.classList.remove('is-error');
    status.textContent = remove.checked ? 'Your photo will be removed when you save.' : '';
    if (remove.checked) {
      const frame = document.createElement('span');
      frame.className = 'profile-avatar avatar-large';
      frame.textContent = profileForm.querySelector('#profile-name').value.trim().split(/\s+/).slice(0,2).map(part => part.charAt(0)).join('').toUpperCase();
      preview.replaceChildren(frame);
    }
  });
  window.addEventListener('pagehide', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
}

const submissionNotice = document.querySelector('[data-submission-notice]');
if (submissionNotice) {
  submissionNotice.focus({ preventScroll: true });
  const bounds = submissionNotice.getBoundingClientRect();
  if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
    submissionNotice.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
}

const menuToggle = document.querySelector('.menu-toggle');
const sidebar = document.querySelector('.sidebar');
if (menuToggle && sidebar) {
  const closeMenu = () => {
    if (sidebar.contains(document.activeElement)) menuToggle.focus();
    sidebar.classList.remove('is-open');
    menuToggle.setAttribute('aria-expanded', 'false');
  };
  menuToggle.addEventListener('click', () => {
    const opened = sidebar.classList.toggle('is-open');
    menuToggle.setAttribute('aria-expanded', String(opened));
    if (opened) sidebar.querySelector('a').focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });
  document.addEventListener('click', event => {
    if (!sidebar.contains(event.target) && !menuToggle.contains(event.target)) closeMenu();
  });
}

document.querySelectorAll('[data-count-for]').forEach(counter => {
  const field = document.getElementById(counter.dataset.countFor);
  if (!field) return;
  const update = () => { counter.textContent = `${field.value.length} / ${field.maxLength}`; };
  field.addEventListener('input', update);
  update();
});

const attachment = document.getElementById('attachment');
const attachmentName = document.getElementById('attachment-name');
if (attachment && attachmentName) {
  attachment.addEventListener('change', () => {
    const file = attachment.files[0];
    attachmentName.textContent = file ? `Selected: ${file.name}` : 'No image selected.';
  });
}

document.querySelectorAll('[data-reactions]').forEach(group => {
  let waiting = false;
  const buttons = [...group.querySelectorAll('button[data-reaction]')];
  const message = group.querySelector('.reaction-message');
  group.querySelectorAll('[data-reaction-form]').forEach(form => {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (waiting) return;
      waiting = true;
      buttons.forEach(button => { button.disabled = true; });
      group.setAttribute('aria-busy', 'true');
      message.hidden = false;
      message.classList.remove('is-error');
      message.textContent = 'Saving reaction...';
      try {
        const response = await fetch(form.action, {
          method: 'POST', credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form))
        });
        if (response.redirected) throw new Error('Your session expired. Sign in again to react.');
        if (!response.ok) throw new Error(response.status === 403 ? 'Your form session expired. Refresh the page and try again.' : response.status === 404 ? 'This feedback is no longer available in the Community Feed.' : 'Could not save your reaction. Refresh the page before trying again.');
        const data = await response.json();
        if (![null, 'support', 'not_helpful'].includes(data.reaction) ||
            !Number.isSafeInteger(data.support_count) || data.support_count < 0 ||
            !Number.isSafeInteger(data.not_helpful_count) || data.not_helpful_count < 0) {
          throw new Error('Could not confirm your reaction. Refresh the page to check it.');
        }
        // Use the committed database totals; failed requests leave the displayed state unchanged.
        buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.reaction === data.reaction)));
        group.querySelector('[data-reaction-count="support"]').textContent = data.support_count;
        group.querySelector('[data-reaction-count="not_helpful"]').textContent = data.not_helpful_count;
        message.textContent = data.reaction === null ? 'Reaction removed.' : data.reaction === 'support' ? 'Support saved.' : 'Not Helpful saved.';
      } catch (error) {
        message.classList.add('is-error');
        message.textContent = error instanceof TypeError ? 'Connection lost. Refresh the page to check your reaction before trying again.' : error.message;
      } finally {
        waiting = false;
        group.removeAttribute('aria-busy');
        buttons.forEach(button => { button.disabled = false; });
      }
    });
  });
});

const assistantForm = document.getElementById('assistant-form');
if (assistantForm) {
  const field = document.getElementById('assistant-message');
  const log = document.getElementById('assistant-log');
  const send = document.getElementById('assistant-send');
  const status = document.getElementById('assistant-status');
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  let waiting = false;
  function appendMessage(author, body, kind) {
    const item = document.createElement('article');
    item.className = `chat-message chat-${kind}`;
    const heading = document.createElement('strong');
    heading.textContent = author;
    const text = document.createElement('p');
    text.className = 'multiline';
    text.textContent = body;
    item.append(heading, text);
    log.append(item);
    item.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  assistantForm.addEventListener('submit', async event => {
    event.preventDefault();
    const message = field.value.trim();
    if (!message || waiting) return;
    waiting = true;
    send.disabled = true;
    field.disabled = true;
    appendMessage('You', message, 'user');
    field.value = '';
    status.textContent = 'Professor is preparing a response…';
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch('/api/professor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message }),
        signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('Professor could not respond. Please try again shortly.'); }
      if (!response.ok || typeof data.reply !== 'string') throw new Error(typeof data.error === 'string' ? data.error : 'Professor is currently unavailable. Please try again shortly.');
      appendMessage('Professor', data.reply, 'assistant');
      status.textContent = '';
    } catch (error) {
      status.textContent = error.name === 'AbortError' ? 'Professor took too long to respond. Please try again.' : error.message || 'Professor is currently unavailable. Please try again shortly.';
    } finally {
      window.clearTimeout(timer);
      waiting = false;
      send.disabled = false;
      field.disabled = false;
      field.focus();
    }
  });
  document.querySelectorAll('[data-assistant-prompt]').forEach(button => {
    button.addEventListener('click', () => {
      if (waiting) return;
      field.value = button.dataset.assistantPrompt;
      field.focus();
    });
  });
}

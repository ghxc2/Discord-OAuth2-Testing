const peopleInCallEl = document.getElementById('people-in-call');
const settingsPageEl = document.getElementById('settingsPage');
const showDisplayKeyBtn = document.getElementById('showDisplayKeyBtn');
const displayKeyValue = document.getElementById('displayKeyValue');
const copyDisplayUrlBtn = document.getElementById('copyDisplayUrlBtn');
const copyDisplayUrlStatus = document.getElementById('copyDisplayUrlStatus');
const rotateDisplayKeyForm = document.getElementById('rotateDisplayKeyForm');

const displayUrl = decodeURIComponent(settingsPageEl?.dataset?.displayUrl || '');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPeopleInCall(users) {
  if (!peopleInCallEl) return;
  if (!users || users.length === 0) {
    peopleInCallEl.innerHTML = '<p>No users currently tracked in voice.</p>';
    return;
  }

  const html = users
    .map((u) => {
      const types = ['speaking', 'avatar', 'muted', 'deafened'];
      const leadAvatarSrc = u.discordAvatarUrl || '';
      const leadAvatarHtml = leadAvatarSrc
        ? `<img src="${leadAvatarSrc}" alt="${escapeHtml(`${u.username || u.userId}-avatar`)}" width="64" height="64" class="avatar-thumb avatar-thumb-64 avatar-thumb-contain mr-6" />`
        : '';
      const avatarSetHtml = types
        .map((type) => {
          const src = (u.avatarSet && u.avatarSet[type]) || (type === 'avatar' ? u.avatarUrl : '');
          if (!src) return '<span class="ml-6">-</span>';
          const alt = escapeHtml(`${u.username || u.userId}-${type}`);
          return `<img src="${src}" alt="${alt}" width="128" height="128" class="avatar-thumb avatar-thumb-128 avatar-thumb-contain ml-6" />`;
        })
        .join('');

      const userLabel = escapeHtml(u.username || u.userId);
      const editUrl = `/settings/${encodeURIComponent(u.userId)}/edit`;
      return `
        <h3>
          ${leadAvatarHtml}
          ${userLabel}
          ${avatarSetHtml}
          <a class="ml-8" href="${editUrl}">Edit Settings</a>
        </h3>
        <hr />
      `;
    })
    .join('');

  peopleInCallEl.innerHTML = html;
}

const settingsEventSource = new EventSource('/settings/events');
settingsEventSource.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    renderPeopleInCall(data.peopleInCall || []);
  } catch (_) {
    // Ignore malformed events to avoid breaking UI.
  }
};

if (showDisplayKeyBtn && displayKeyValue) {
  showDisplayKeyBtn.addEventListener('click', () => {
    displayKeyValue.classList.remove('hidden');
    showDisplayKeyBtn.classList.add('hidden');
  });
}

if (copyDisplayUrlBtn && displayUrl) {
  copyDisplayUrlBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(displayUrl);
    } catch (_) {
      const tempEl = document.createElement('textarea');
      tempEl.value = displayUrl;
      document.body.appendChild(tempEl);
      tempEl.select();
      document.execCommand('copy');
      document.body.removeChild(tempEl);
    }
    if (copyDisplayUrlStatus) {
      copyDisplayUrlStatus.classList.remove('hidden');
      setTimeout(() => {
        copyDisplayUrlStatus.classList.add('hidden');
      }, 1200);
    }
  });
}

if (rotateDisplayKeyForm) {
  rotateDisplayKeyForm.addEventListener('submit', (event) => {
    const shouldContinue = window.confirm('Rotate display key? Existing display URLs will stop working.');
    if (!shouldContinue) {
      event.preventDefault();
    }
  });
}

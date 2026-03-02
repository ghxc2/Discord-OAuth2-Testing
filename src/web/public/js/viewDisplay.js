const usersById = {};
const root = document.getElementById('viewDisplayRoot') || document.body || document.documentElement;
const initialUsersEncoded = root?.dataset?.initialUsers || '';
const streamPathEncoded = root?.dataset?.voiceEventPath || '';

function pickAvatarForState(avatarSet, state) {
  const safeSet = avatarSet || {};
  const isDeaf = !!state?.deaf;
  const isMuted = !!state?.mute;
  const isSpeaking = !!state?.speaking;

  if (isDeaf) return safeSet.deafened || safeSet.muted || safeSet.speaking || safeSet.avatar || safeSet.default || '';
  if (isMuted) return safeSet.muted || safeSet.deafened || safeSet.speaking || safeSet.avatar || safeSet.default || '';
  if (isSpeaking) return safeSet.speaking || safeSet.avatar || safeSet.default || '';
  return safeSet.avatar || safeSet.default || safeSet.speaking || '';
}

function renderDisplay() {
  if (!root) return;
  const users = Object.values(usersById);

  document.querySelectorAll('img[data-display-avatar="1"]').forEach((img) => img.remove());
  if (!users.length) return;

  const fragment = document.createDocumentFragment();
  users.forEach((u) => {
    const avatarSrc = pickAvatarForState(u.avatarSet, u) || u.avatarUrl || '';
    if (!avatarSrc) return;
    const img = document.createElement('img');
    img.src = avatarSrc;
    img.alt = `${u.username || u.userId || 'user'} avatar`;
    img.width = 300;
    img.height = 300;
    img.className = 'display-avatar';
    img.setAttribute('data-display-avatar', '1');
    fragment.appendChild(img);
  });
  root.appendChild(fragment);
}

const initialUsers = (() => {
  if (!initialUsersEncoded) return [];
  try {
    return JSON.parse(decodeURIComponent(initialUsersEncoded));
  } catch (_) {
    return [];
  }
})();

if (Array.isArray(initialUsers)) {
  initialUsers.forEach((u) => {
    usersById[u.userId] = u;
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderDisplay);
} else {
  renderDisplay();
}

const streamPath = streamPathEncoded ? decodeURIComponent(streamPathEncoded) : '/voice/events';
const stream = new EventSource(streamPath);

stream.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.type === 'state' && data.users) {
    const incoming = data.users;
    Object.keys(usersById).forEach((k) => {
      if (!incoming[k]) delete usersById[k];
    });
    Object.keys(incoming).forEach((k) => {
      const prev = usersById[k] || {};
      usersById[k] = { ...prev, ...incoming[k] };
    });
    renderDisplay();
  }
};

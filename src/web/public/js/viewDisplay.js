const usersById = {};
const root = document.getElementById('viewDisplayRoot') || document.body || document.documentElement;
const initialUsersEncoded = root?.dataset?.initialUsers || '';
const streamPathEncoded = root?.dataset?.voiceEventPath || '';
const imageElsByUserId = new Map();

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
  const presentUserIds = new Set();
  users.forEach((u) => {
    presentUserIds.add(String(u.userId));
    const avatarSrc = pickAvatarForState(u.avatarSet, u) || u.avatarUrl || '';
    if (!avatarSrc) return;

    const userId = String(u.userId);
    let img = imageElsByUserId.get(userId);
    if (!img) {
      img = document.createElement('img');
      img.setAttribute('data-display-avatar', '1');
      img.setAttribute('data-user-id', userId);
      img.width = 300;
      img.height = 300;
      img.className = 'display-avatar';
      imageElsByUserId.set(userId, img);
      root.appendChild(img);
    }

    img.alt = `${u.username || u.userId || 'user'} avatar`;

    const currentSrc = img.dataset.currentSrc || '';
    if (currentSrc !== avatarSrc) {
      const nextSrc = avatarSrc;
      img.dataset.pendingSrc = nextSrc;
      const preloader = new Image();
      preloader.onload = () => {
        if (img.dataset.pendingSrc !== nextSrc) return;
        img.src = nextSrc;
        img.dataset.currentSrc = nextSrc;
        delete img.dataset.pendingSrc;
      };
      preloader.onerror = () => {
        if (img.dataset.pendingSrc !== nextSrc) return;
        delete img.dataset.pendingSrc;
      };
      preloader.src = nextSrc;
    }

    root.appendChild(img);
  });

  for (const [userId, img] of imageElsByUserId.entries()) {
    if (presentUserIds.has(userId)) continue;
    img.remove();
    imageElsByUserId.delete(userId);
  }
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

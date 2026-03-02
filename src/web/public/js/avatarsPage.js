const avatarsPageEl = document.getElementById('avatarsPage');
const createAvatarSetForm = document.getElementById('createAvatarSetForm');

if (createAvatarSetForm && avatarsPageEl) {
  createAvatarSetForm.addEventListener('submit', (event) => {
    const ownerUserId = avatarsPageEl.dataset.ownerUserId || '';
    const assetIdInput = createAvatarSetForm.querySelector('input[name="assetId"]');
    const assetId = (assetIdInput?.value || '').trim();
    if (!ownerUserId || !assetId) {
      event.preventDefault();
      return;
    }
    createAvatarSetForm.action = `/avatars/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(assetId)}`;
  });
}

document.querySelectorAll('form.js-confirm-delete-avatar-set').forEach((formEl) => {
  formEl.addEventListener('submit', (event) => {
    const shouldContinue = window.confirm('Delete this avatar set and all its images?');
    if (!shouldContinue) {
      event.preventDefault();
    }
  });
});

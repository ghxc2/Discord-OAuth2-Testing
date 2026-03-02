document.querySelectorAll('input.js-auto-submit-upload').forEach((inputEl) => {
  inputEl.addEventListener('change', () => {
    const formEl = inputEl.closest('form');
    const assetType = inputEl.dataset.assetType || '';
    const actionPrefix = formEl?.dataset?.uploadActionPrefix || '';
    if (formEl) {
      if (!assetType || !actionPrefix) return;
      formEl.method = 'post';
      formEl.action = `${actionPrefix}/${encodeURIComponent(assetType)}`;
      formEl.submit();
    }
  });
});

document.querySelectorAll('form.js-confirm-delete-avatar-type').forEach((formEl) => {
  formEl.addEventListener('submit', (event) => {
    const shouldContinue = window.confirm('Delete this image type from the set?');
    if (!shouldContinue) {
      event.preventDefault();
    }
  });
});

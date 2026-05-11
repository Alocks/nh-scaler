// Load current preset and set radio button
async function loadCurrentPreset() {
  const result = await chrome.storage.sync.get(['simplePreset']);
  const currentPreset = result.simplePreset || 'M';
  
  const radio = document.querySelector(`input[name="preset"][value="${currentPreset}"]`);
  if (radio) {
    radio.checked = true;
  }
}

// Save preset on selection change
document.querySelectorAll('input[name="preset"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    if (e.target.checked) {
      chrome.storage.sync.set({ simplePreset: e.target.value });
    }
  });
});

// Load on popup open
loadCurrentPreset();

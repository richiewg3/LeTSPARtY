document.addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  const buttons = document.querySelectorAll('.mode-btn');

  // Default to light mode
  body.classList.add('light');
  document.getElementById('light').classList.add('active');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;

      // Remove all mode classes
      body.classList.remove('light', 'dark', 'party');
      buttons.forEach((b) => b.classList.remove('active'));

      // Apply selected mode
      body.classList.add(mode);
      btn.classList.add('active');
    });
  });
});

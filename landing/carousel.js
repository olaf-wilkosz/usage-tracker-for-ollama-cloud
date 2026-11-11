// Screenshot carousel and lightbox for the landing page. Plain scroll-snap does the sliding
// (touch, trackpad and the scrollbar work without this script); the script adds the buttons, the
// dots, arrow keys, a spoken "n of N" and the enlarged view. Nothing moves by itself.
(() => {
  const carousel = document.querySelector('.carousel');
  if (!carousel) return;

  const track = carousel.querySelector('.car-track');
  const slides = [...track.children];
  const prev = carousel.querySelector('.car-prev');
  const next = carousel.querySelector('.car-next');
  const dotsBox = carousel.querySelector('.car-dots');
  const status = carousel.querySelector('.car-status');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const indexNow = () => Math.round(track.scrollLeft / track.clientWidth);
  const goTo = (index) => {
    const clamped = Math.max(0, Math.min(slides.length - 1, index));
    track.scrollTo({ left: clamped * track.clientWidth, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  };

  const dots = slides.map((slide, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'car-dot';
    dot.setAttribute('aria-label', `Show screenshot ${i + 1} of ${slides.length}`);
    dot.addEventListener('click', () => goTo(i));
    dotsBox.appendChild(dot);
    return dot;
  });

  let shown = -1;
  const sync = () => {
    const i = Math.max(0, Math.min(slides.length - 1, indexNow()));
    if (i === shown) return;
    shown = i;
    dots.forEach((dot, n) => dot.setAttribute('aria-current', String(n === i)));
    prev.disabled = i === 0;
    next.disabled = i === slides.length - 1;
    status.textContent = `Screenshot ${i + 1} of ${slides.length}`;
  };

  prev.addEventListener('click', () => goTo(indexNow() - 1));
  next.addEventListener('click', () => goTo(indexNow() + 1));
  track.addEventListener('scroll', () => window.requestAnimationFrame(sync), { passive: true });
  window.addEventListener('resize', () => goTo(shown));
  carousel.addEventListener('keydown', (event) => {
    if (event.target.closest('dialog')) return;
    if (event.key === 'ArrowLeft') { goTo(indexNow() - 1); event.preventDefault(); }
    if (event.key === 'ArrowRight') { goTo(indexNow() + 1); event.preventDefault(); }
  });
  sync();

  // ---- lightbox: the same screenshot at twice the resolution ----
  const dialog = document.getElementById('lightbox');
  const image = dialog.querySelector('img');
  const zoomBtn = dialog.querySelector('.lb-zoom');
  const closeBtn = dialog.querySelector('.lb-close');

  const setActualSize = (actual) => {
    image.classList.toggle('actual', actual);
    zoomBtn.setAttribute('aria-pressed', String(actual));
    zoomBtn.textContent = actual ? 'Fit to window' : 'Actual size';
  };

  carousel.querySelectorAll('.zoom').forEach((button) => {
    button.addEventListener('click', () => {
      image.src = button.dataset.full;
      image.alt = button.querySelector('img').alt;
      setActualSize(false);
      dialog.showModal();
    });
  });

  zoomBtn.addEventListener('click', () => setActualSize(!image.classList.contains('actual')));
  image.addEventListener('click', () => setActualSize(!image.classList.contains('actual')));
  closeBtn.addEventListener('click', () => dialog.close());
  // a click on the dark backdrop (the dialog element itself) closes it
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => { image.removeAttribute('src'); });
})();

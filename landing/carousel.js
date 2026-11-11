// Screenshot carousel and lightbox for the landing page. Plain scroll-snap does the sliding
// (swiping, trackpad and the scrollbar work without this script); the script adds the side
// arrows, the dots, arrow keys, a spoken "n of N" and the enlarged view. Nothing moves by itself.
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
  const goTo = (index, instant = false) => {
    const clamped = Math.max(0, Math.min(slides.length - 1, index));
    track.scrollTo({ left: clamped * track.clientWidth, behavior: instant || reduceMotion.matches ? 'auto' : 'smooth' });
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
  window.addEventListener('resize', () => goTo(shown, true));
  carousel.addEventListener('keydown', (event) => {
    if (event.target.closest('dialog')) return;
    if (event.key === 'ArrowLeft') { goTo(indexNow() - 1); event.preventDefault(); }
    if (event.key === 'ArrowRight') { goTo(indexNow() + 1); event.preventDefault(); }
  });
  sync();

  // ---- lightbox: the same screenshots at twice the resolution, kept in step with the carousel ----
  const dialog = document.getElementById('lightbox');
  const image = dialog.querySelector('img');
  const count = dialog.querySelector('.lb-count');
  const lbPrev = dialog.querySelector('.lb-prev');
  const lbNext = dialog.querySelector('.lb-next');
  const zooms = slides.map((slide) => slide.querySelector('.zoom'));
  let current = 0;

  const show = (index) => {
    const target = Math.max(0, Math.min(zooms.length - 1, index));
    const direction = Math.sign(target - current);
    current = target;
    const button = zooms[current];
    image.src = button.dataset.full;
    image.alt = button.querySelector('img').alt;
    count.textContent = `${current + 1} / ${zooms.length}`;
    lbPrev.disabled = current === 0;
    lbNext.disabled = current === zooms.length - 1;

    // a short slide-and-fade in the direction of travel (skipped for reduced motion)
    image.classList.remove('from-left', 'from-right');
    if (direction !== 0 && !reduceMotion.matches) {
      void image.offsetWidth; // restart the animation
      image.classList.add(direction > 0 ? 'from-right' : 'from-left');
    }

    // the carousel underneath follows, so closing the view lands on the same screenshot
    goTo(current, true);
    // warm up the neighbours so stepping through is instant
    for (const n of [current - 1, current + 1]) {
      if (zooms[n]) new Image().src = zooms[n].dataset.full;
    }
  };

  // On a small touch screen the enlarged view adds nothing (the picture already fills the width and
  // pinch-zoom is there): the screenshot becomes a plain frame, not a button that does nothing.
  const smallTouch = window.matchMedia('(hover: none) and (pointer: coarse) and (max-width: 899px)');
  const frames = zooms.map(() => document.createElement('div'));
  frames.forEach((frame) => { frame.className = 'zoom zoom-static'; });
  const setZoomable = () => {
    zooms.forEach((button, i) => {
      const from = smallTouch.matches ? button : frames[i];
      const to = smallTouch.matches ? frames[i] : button;
      const img = from.querySelector('img');
      if (!img) return;
      to.appendChild(img);
      from.replaceWith(to);
    });
  };
  setZoomable();
  smallTouch.addEventListener('change', setZoomable);

  zooms.forEach((button, i) => {
    button.addEventListener('click', () => {
      current = i;
      show(i);
      document.documentElement.classList.add('lb-open'); // the page behind stops scrolling
      dialog.showModal();
    });
  });

  lbPrev.addEventListener('click', () => show(current - 1));
  lbNext.addEventListener('click', () => show(current + 1));
  dialog.querySelector('.lb-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { show(current - 1); event.preventDefault(); }
    if (event.key === 'ArrowRight') { show(current + 1); event.preventDefault(); }
  });
  // a click on the dark area around the picture (the dialog element itself) closes it
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('lb-open');
    image.removeAttribute('src');
    sync();
  });

  // swipe left / right on the enlarged picture (the carousel itself swipes natively)
  let swipeStart = null;
  image.addEventListener('pointerdown', (event) => { swipeStart = { x: event.clientX, y: event.clientY }; });
  image.addEventListener('pointerup', (event) => {
    if (!swipeStart) return;
    const dx = event.clientX - swipeStart.x;
    const dy = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) show(current + (dx < 0 ? 1 : -1));
  });
  image.addEventListener('pointercancel', () => { swipeStart = null; });
})();

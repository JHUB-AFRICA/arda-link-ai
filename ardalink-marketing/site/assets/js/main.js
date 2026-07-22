// ArdaLink site — small interactions only.
// No framework; CSS @keyframes handles fade-up, JS handles stat values
// and the mobile menu.
(function () {
  const reduceMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  // Count-up stats — animate from 0 to target when scrolled into view.
  // Falls back to the final value immediately if IntersectionObserver or
  // motion is unavailable.
  const valueEls = document.querySelectorAll('.stat .v[data-count], .evidence .v[data-count]');
  function fmt(el) {
    const decimals = parseInt(el.dataset.decimals || '0', 10);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    return (n) => prefix + n.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }) + suffix;
  }
  function countUp(el) {
    const target = parseFloat(el.dataset.count);
    const render = fmt(el);
    const sink = el.firstElementChild || el;
    if (reduceMotion || !('requestAnimationFrame' in window)) {
      sink.textContent = render(target);
      return;
    }
    const dur = 1100;
    const start = performance.now();
    (function tick(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      sink.textContent = render(target * eased);
      if (p < 1) requestAnimationFrame(tick);
      else sink.textContent = render(target);
    })(start);
  }

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { countUp(e.target); obs.unobserve(e.target); }
      });
    }, { threshold: 0.4 });
    valueEls.forEach((el) => io.observe(el));
  } else {
    valueEls.forEach((el) => {
      (el.firstElementChild || el).textContent = fmt(el)(parseFloat(el.dataset.count));
    });
  }

  // Scroll-reveal — add .reveal to opt in, .is-visible fires on enter.
  const revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach((el) => el.classList.add('is-visible'));
    } else {
      const ro = new IntersectionObserver((entries, obs) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add('is-visible'); obs.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      revealEls.forEach((el) => ro.observe(el));
    }
  }

  // Mobile menu
  const toggle = document.querySelector('.menu-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      links.classList.toggle('open');
      const open = links.classList.contains('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') links.classList.remove('open');
    });
  }

  // Year stamp
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();

// ArdaLink site — small interactions only.
// No framework; CSS @keyframes handles fade-up, JS handles stat values
// and the mobile menu.
(function () {
  // Count-up stats — render the final value from the start.
  const valueEls = document.querySelectorAll('.stat .v[data-count]');
  function fmt(el) {
    const decimals = parseInt(el.dataset.decimals || '0', 10);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    return (n) => prefix + n.toFixed(decimals) + suffix;
  }
  valueEls.forEach((el) => {
    const target = parseFloat(el.dataset.count);
    el.firstElementChild.textContent = fmt(el)(target);
  });

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

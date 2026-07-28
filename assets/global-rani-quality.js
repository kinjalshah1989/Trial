(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const saveData = navigator.connection?.saveData === true;

  root.classList.add('quality-js');
  if (reduceMotion) root.classList.add('quality-reduced-motion');
  if (saveData) root.classList.add('quality-save-data');

  const optimizeImage = (image) => {
    if (!(image instanceof HTMLImageElement)) return;
    if (!image.hasAttribute('decoding')) image.decoding = 'async';

    const rect = image.getBoundingClientRect();
    const hiddenOrZeroSize = rect.width === 0 && rect.height === 0;
    const belowInitialView = rect.top > window.innerHeight * 1.15;
    if ((hiddenOrZeroSize || belowInitialView) && !image.hasAttribute('loading')) image.loading = 'lazy';
    if (!hiddenOrZeroSize && !belowInitialView && !image.hasAttribute('fetchpriority')) {
      image.setAttribute('fetchpriority', 'high');
    }
  };

  document.querySelectorAll('img').forEach(optimizeImage);

  const imageObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLImageElement) optimizeImage(node);
        if (node instanceof Element) node.querySelectorAll('img').forEach(optimizeImage);
      });
    });
  });
  imageObserver.observe(document.body, { childList:true, subtree:true });

  document.querySelectorAll('a[target="_blank"]').forEach((link) => {
    const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
    rel.add('noopener');
    rel.add('noreferrer');
    link.setAttribute('rel', [...rel].join(' '));
  });

  document.querySelectorAll('.status').forEach((status) => {
    if (!status.hasAttribute('role')) status.setAttribute('role', 'status');
    if (!status.hasAttribute('aria-live')) status.setAttribute('aria-live', 'polite');
  });

  const updateVisibility = () => {
    root.classList.toggle('quality-page-hidden', document.hidden);
  };
  document.addEventListener('visibilitychange', updateVisibility, { passive:true });
  updateVisibility();
})();

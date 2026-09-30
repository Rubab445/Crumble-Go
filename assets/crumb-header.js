const DRAWER_SELECTOR = '[data-crumb-drawer]';
const OPEN_SELECTOR = '[data-crumb-drawer-open]';
const CLOSE_SELECTOR = '[data-crumb-drawer-close]';
const DESKTOP_QUERY = '(min-width: 990px)';

// @ts-ignore
if (!window.__crumbHeaderReady) {
  // @ts-ignore
  window.__crumbHeaderReady = true;

  /** @returns {HTMLDialogElement | null} */
  const getDrawer = () => document.querySelector(DRAWER_SELECTOR);

  /** @param {boolean} expanded */
  const setExpanded = (expanded) => {
    for (const opener of document.querySelectorAll(OPEN_SELECTOR)) {
      opener.setAttribute('aria-expanded', String(expanded));
    }
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const drawer = getDrawer();
    if (!drawer) return;

    if (target.closest(OPEN_SELECTOR)) {
      if (!drawer.open) drawer.showModal();
      setExpanded(true);
      return;
    }

    // Close button, a tap on the backdrop (the dialog element itself), or a link inside the drawer
    if (target.closest(CLOSE_SELECTOR) || target === drawer || target.closest('.crumb-drawer a')) {
      drawer.close();
    }
  });

  // `close` does not bubble, so listen in the capture phase.
  document.addEventListener(
    'close',
    (event) => {
      if (event.target instanceof Element && event.target.matches(DRAWER_SELECTOR)) {
        setExpanded(false);
      }
    },
    true
  );

  // Never leave the drawer open after the viewport grows to the desktop layout.
  window.matchMedia(DESKTOP_QUERY).addEventListener('change', (event) => {
    if (event.matches) getDrawer()?.close();
  });
}
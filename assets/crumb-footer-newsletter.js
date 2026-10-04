/**
 * Crumb & Co. footer newsletter: progressive AJAX enhancement.
 *
 * {% form 'customer' %} is a plain native Shopify form — same as Horizon's own
 * blocks/email-signup.liquid. Submitting it natively reloads the page and the
 * browser jumps to an anchor near the form, which looks like a broken layout
 * on a short page (the footer lands near the top, lots of blank space below).
 *
 * This intercepts submit, posts via fetch, and swaps in just the server's
 * rendered result (success message, or error + re-shown input) — no reload,
 * no scroll jump. If the request itself fails (offline, etc.), it falls back
 * to a real native submit rather than silently doing nothing.
 */

function initCrumbNewsletterForm(form) {
  if (!form || form.dataset.crumbNewsletterBound) return;
  form.dataset.crumbNewsletterBound = 'true';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton?.setAttribute('disabled', 'true');

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { Accept: 'text/html' },
      });
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const freshBody = doc.querySelector('.crumb-footer__newsletter-body');
      const currentBody = form.querySelector('.crumb-footer__newsletter-body');

      if (freshBody && currentBody) {
        currentBody.replaceWith(freshBody);
        // Move focus to whatever the server rendered (error or success message)
        // so screen reader users get the result, not silence.
        const message = freshBody.querySelector('.crumb-footer__newsletter-message');
        if (message) {
          message.setAttribute('tabindex', '-1');
          // @ts-ignore
          message.focus();
        }
      } else {
        // Response didn't look like what we expected — safest bet is a real submit.
        HTMLFormElement.prototype.submit.call(form);
      }
    } catch (error) {
      // Network failure: fall back to a real submit so the user's input isn't lost.
      HTMLFormElement.prototype.submit.call(form);
    } finally {
      submitButton?.removeAttribute('disabled');
    }
  });
}

document.querySelectorAll('[data-crumb-newsletter-form]').forEach(initCrumbNewsletterForm);
// @ts-nocheck
/**
 * Saves the gift tick straight away, so it survives the cart re-rendering when quantities change.
 * The form attribute on the input still carries it to checkout if this script fails.
 */
class CrumbGiftToggle extends HTMLElement {
  connectedCallback() {
    this.input = this.querySelector('input[type="checkbox"]');
    this.onChange = () => this.save();
    this.input?.addEventListener('change', this.onChange);
  }

  disconnectedCallback() {
    this.input?.removeEventListener('change', this.onChange);
  }

  async save() {
    try {
      await fetch(this.dataset.updateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ attributes: { Gift: this.input.checked ? 'Yes' : '' } }),
      });
    } catch (error) {
      // Not fatal: the form still sends the value when they press Check out.
    }
  }
}

if (!customElements.get('crumb-gift-toggle')) {
  customElements.define('crumb-gift-toggle', CrumbGiftToggle);
}
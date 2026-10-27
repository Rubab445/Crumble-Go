// @ts-nocheck
/**
 * Crumb build-a-box.
 *
 * The page is server-rendered (sizes, snacks, prices). This element adds behavior only:
 * it keeps { size, snacks } in memory + sessionStorage, redraws the tray and summary text, and
 * sends one /cart/add.js request. It never calculates a price. It reads pre-formatted text from
 * data attributes, and the real charge is the bundle product's variant price.
 *
 * Tray entries are VARIANT ids. A single-variant snack has one id. A snack with variants
 * opens a picker and adds the chosen variant.
 */

const STORAGE_KEY = "crumb-build-box:v2";

/** Replace %token% placeholders. Strings come from locales/en.default.json via the section. */
const fmt = (template, vars = {}) =>
  String(template).replace(/%(\w+)%/g, (match, key) =>
    key in vars ? String(vars[key]) : match,
  );

const readStorage = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
};

const writeStorage = (value) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (error) {
    /* storage can be blocked: the box still works for this page view */
  }
};

class CrumbBuildBox extends HTMLElement {
  connectedCallback() {
    const stringsElement = this.querySelector("[data-strings]");
    if (!stringsElement) return;

    this.abort = new AbortController();
    const { signal } = this.abort;

    this.strings = JSON.parse(stringsElement.textContent || "{}");
    this.adding = false;
    this.focusTarget = null;
    this.pendingChoose = null;

    const q = (selector) => this.querySelector(selector);
    this.refs = {
      live: q("[data-live]"),
      fullHint: q("[data-full-hint]"),
      notice: q("[data-notice]"),
      trayTitle: q("[data-tray-title]"),
      trayNumber: q("[data-tray-number]"),
      badge: q("[data-badge]"),
      selected: q("[data-selected]"),
      packed: q("[data-packed]"),
      percent: q("[data-percent]"),
      progress: q("[data-progress]"),
      progressText: q("[data-progress-text]"),
      slots: q("[data-slots]"),
      dips: [...this.querySelectorAll("[data-dip-banner]")],
      alert: q("[data-alert-text]"),
      picked: q("[data-picked]"),
      saveInline: q("[data-save-inline]"),
      price: q("[data-price]"),
      baseInline: q("[data-base-inline]"),
      sizeName: q("[data-size-name]"),
      baseRow: q("[data-base-row]"),
      base: q("[data-base]"),
      tierPrice: q("[data-tier-price]"),
      discountRow: q("[data-discount-row]"),
      discountTag: q("[data-discount-tag]"),
      cta: q("[data-cta]"),
      ctaLabel: q("[data-cta-label]"),
      error: q("[data-error]"),
      success: q("[data-success]"),
      dialog: q("[data-dialog]"),
      chooser: q("[data-chooser]"),
      chips: [...this.querySelectorAll("[data-filter-chip]")],
      diets: [...this.querySelectorAll("[data-diet-toggle]")],
      search: q("[data-search]"),
      filterStatus: q("[data-filter-status]"),
      filterEmpty: q("[data-filter-empty]"),
      catalog: q(".crumb-build__catalog"),
    };

    this.sizes = [...this.querySelectorAll("[data-size-input]")].map(
      (input) => ({
        input,
        handle: input.value,
        title: input.dataset.title || "",
        variantId: input.dataset.variantId || "",
        slots: Number(input.dataset.slotCount) || 0,
        available: !input.disabled,
        priceText: input.dataset.priceText || "",
        baseText: input.dataset.baseText || "",
        savePct: Number(input.dataset.savePct) || 0,
        popular: input.dataset.popular === "true",
      }),
    );

    this.buildCatalog();
    this.filters = { tag: "", diets: new Set(), query: "" };
    this.searchTimer = 0;

    this.addEventListener("click", (event) => this.onClick(event), { signal });
    this.addEventListener("change", (event) => this.onChange(event), {
      signal,
    });
    this.addEventListener("input", (event) => this.onInput(event), { signal });

    this.state = this.restore();
    this.setAttribute("data-js", "");
    this.render();
    this.persist();

    // A ?snack= link to a snack with variants opens its picker.
    if (this.pendingChoose) {
      const card = this.pendingChoose;
      this.pendingChoose = null;
      this.openChooser(card);
    }
  }

  disconnectedCallback() {
    if (this.abort) this.abort.abort();
    window.clearTimeout(this.searchTimer);
  }

  /* ---------- catalog ---------- */

  /** Reads every snack card once. `items` maps a variant id to what the tray needs to draw it. */
  buildCatalog() {
    this.cards = new Map();
    this.items = new Map();

    for (const el of this.querySelectorAll("[data-snack]")) {
      let variants = [];
      const variantsElement = el.querySelector("[data-variants]");
      if (variantsElement) {
        try {
          variants = JSON.parse(variantsElement.textContent || "[]");
        } catch (error) {
          variants = [];
        }
      }

      const card = {
        el,
        handle: el.dataset.handle,
        title: el.dataset.title || "",
        image: el.dataset.image || "",
        priceText: el.dataset.priceText || "",
        pickable: el.dataset.available === "true",
        choosable: el.dataset.choosable === "true",
        variantId: el.dataset.variantId || "",
        tags: (el.dataset.tags || '').split(' ').filter(Boolean),
        name: (el.dataset.title || '').toLowerCase(),
        variants,
        add: el.querySelector("[data-add]"),
        stepper: el.querySelector("[data-stepper]"),
        count: el.querySelector("[data-count]"),
        increase: el.querySelector("[data-increase]"),
        decrease: el.querySelector("[data-decrease]"),
        choose: el.querySelector("[data-choose]"),
        chooseCount: el.querySelector("[data-choose-count]"),
      };
      this.cards.set(card.handle, card);

      if (card.pickable && card.variantId) {
        this.items.set(card.variantId, {
          card,
          title: card.title,
          image: card.image,
          priceText: card.priceText,
          available: true,
        });
      }

      if (card.choosable) {
        for (const variant of variants) {
          this.items.set(String(variant.id), {
            card,
            title: fmt(this.strings.variant_label, {
              title: card.title,
              variant: variant.title,
            }),
            image: variant.image || card.image,
            priceText: variant.price || card.priceText,
            available: Boolean(variant.available),
          });
        }
      }
    }
  }

  /* ---------- state ---------- */

  get size() {
    return this.sizes.find((size) => size.handle === this.state.size) || null;
  }

  get capacity() {
    return this.size ? this.size.slots : 0;
  }

  get isFull() {
    return this.capacity > 0 && this.state.snacks.length >= this.capacity;
  }

  defaultSize() {
    const available = this.sizes.filter((size) => size.available);
    return available.find((size) => size.popular) || available[0] || null;
  }

  isPickable(variantId) {
    const item = this.items.get(String(variantId));
    return Boolean(item && item.available);
  }

  /** Build the starting state from storage and the URL, validated against what is on the page. */
  restore() {
    const params = new URLSearchParams(window.location.search);
    const stored = readStorage();
    let notice = "";

    const wantedHandle = params.get("size") || (stored && stored.size) || "";
    const size =
      this.sizes.find(
        (item) => item.handle === wantedHandle && item.available,
      ) || this.defaultSize();

    let snacks =
      stored && Array.isArray(stored.snacks) ? stored.snacks.map(String) : [];
    const before = snacks.length;
    snacks = snacks.filter((id) => this.isPickable(id));
    if (snacks.length < before) notice = this.strings.notice_unavailable;

    if (size && snacks.length > size.slots) {
      snacks = snacks.slice(0, size.slots);
      notice = this.strings.notice_trimmed;
    }

    const snackParam = params.get("snack");
    const snackCard = snackParam ? this.cards.get(snackParam) : null;
    if (size && snackCard) {
      if (
        snackCard.pickable &&
        snackCard.variantId &&
        snacks.length < size.slots
      ) {
        snacks.push(snackCard.variantId);
      } else if (snackCard.choosable) {
        this.pendingChoose = snackCard;
      }
    }

    // Clear the link parameters so a refresh does not add the snack a second time.
    if (params.has("snack") || params.has("size")) {
      params.delete("snack");
      params.delete("size");
      const query = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname +
          (query ? `?${query}` : "") +
          window.location.hash,
      );
    }

    this.showNotice(notice);
    return { size: size ? size.handle : null, snacks };
  }

  persist() {
    writeStorage({ size: this.state.size, snacks: this.state.snacks });
  }

  /** Save, redraw, announce and restore focus. Every change goes through here. */
  commit(message) {
    this.persist();
    this.refs.success.hidden = true;
    this.render();
    if (message) this.announce(message);
    this.applyFocus();
  }

  /* ---------- events ---------- */

  onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest("[data-chooser-cancel]")) {
      if (this.refs.chooser) this.refs.chooser.close("cancel");
      return;
    }
        const chip = target.closest('[data-filter-chip]');
    if (chip) {
      this.filters.tag = chip.dataset.filterChip || '';
      this.applyFilters();
      return;
    }

    const diet = target.closest('[data-diet-toggle]');
    if (diet) {
      const value = diet.dataset.dietToggle;
      if (this.filters.diets.has(value)) this.filters.diets.delete(value);
      else this.filters.diets.add(value);
      this.applyFilters();
      return;
    }

    if (target.closest('[data-filter-clear]')) {
      this.clearFilters();
      return;
    }
    const cardElement = target.closest("[data-snack]");
    const card = cardElement
      ? this.cards.get(cardElement.dataset.handle)
      : null;
    const add = target.closest("[data-add]");
    const increase = target.closest("[data-increase]");
    const decrease = target.closest("[data-decrease]");
    const choose = target.closest("[data-choose]");
    const removeSlot = target.closest("[data-remove-slot]");

    if ((add || increase) && card) {
      const button = add || increase;
      if (button.getAttribute("aria-disabled") === "true") {
        this.announce(this.strings.full_hint);
        return;
      }
      this.addItem(card.variantId, add ? "add" : "increase");
    } else if (choose && card) {
      if (choose.getAttribute("aria-disabled") === "true") {
        this.announce(this.strings.full_hint);
        return;
      }
      this.openChooser(card);
    } else if (decrease && card) {
      this.removeItem(card.variantId);
    } else if (removeSlot) {
      this.removeSlot(Number(removeSlot.dataset.index));
    } else if (target.closest("[data-reset]")) {
      this.resetBox();
    } else if (target.closest("[data-cta]")) {
      this.addToCart();
    }
  }

  onChange(event) {
    const input = event.target;
    if (
      input instanceof HTMLInputElement &&
      input.matches("[data-size-input]")
    ) {
      this.changeSize(input.value);
    }
  }

    /* ---------- filters ---------- */

  onInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-search]')) return;

    window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.filters.query = input.value.trim().toLowerCase();
      this.applyFilters();
    }, 200);
  }

  clearFilters() {
    this.filters = { tag: '', diets: new Set(), query: '' };
    if (this.refs.search) this.refs.search.value = '';
    this.applyFilters();
  }

  /** Shows or hides the snack cards. Only the catalog changes: the tray keeps every pick. */
  applyFilters() {
    const { tag, diets, query } = this.filters;
    const { refs, strings } = this;
    let shown = 0;

    for (const card of this.cards.values()) {
      const match =
        (!tag || card.tags.includes(tag)) &&
        [...diets].every((value) => card.tags.includes(value)) &&
        (!query || card.name.includes(query));
      card.el.hidden = !match;
      if (match) shown += 1;
    }

    for (const chip of refs.chips) {
      chip.setAttribute('aria-pressed', String((chip.dataset.filterChip || '') === tag));
    }
    for (const toggle of refs.diets) {
      toggle.setAttribute('aria-pressed', String(diets.has(toggle.dataset.dietToggle)));
    }

    if (refs.filterEmpty) refs.filterEmpty.hidden = shown > 0;
    if (refs.filterStatus) {
      refs.filterStatus.textContent = shown === 1 ? strings.filter_status_one : fmt(strings.filter_status_other, { count: shown });
    }
  }

  /* ---------- actions ---------- */

  addItem(variantId, source) {
    const item = this.items.get(String(variantId));
    if (!item || !item.available || !this.size) return;
    if (this.isFull) {
      this.announce(this.strings.full_hint);
      return;
    }

    this.state.snacks.push(String(variantId));
    // The Add button turns into a stepper: move focus to the stepper's "add one more" button.
    this.focusTarget =
      source === "add" ? { type: "increase", handle: item.card.handle } : null;
    this.commit(
      fmt(this.strings.added_announce, {
        title: item.title,
        filled: this.state.snacks.length,
        total: this.capacity,
      }),
    );
  }

  removeItem(variantId) {
    const item = this.items.get(String(variantId));
    const index = this.state.snacks.lastIndexOf(String(variantId));
    if (!item || index === -1) return;

    this.state.snacks.splice(index, 1);
    const stillInBox = this.state.snacks.includes(String(variantId));
    this.focusTarget = stillInBox
      ? null
      : { type: "add", handle: item.card.handle };
    this.commit(
      fmt(this.strings.removed_announce, {
        title: item.title,
        filled: this.state.snacks.length,
        total: this.capacity,
      }),
    );
  }

  removeSlot(index) {
    const item = this.items.get(this.state.snacks[index]);
    if (!item) return;

    this.state.snacks.splice(index, 1);
    this.focusTarget = { type: "slot", index };
    this.commit(
      fmt(this.strings.removed_announce, {
        title: item.title,
        filled: this.state.snacks.length,
        total: this.capacity,
      }),
    );
  }

  async resetBox() {
    if (this.state.snacks.length === 0) return;
    const ok = await this.confirm({
      title: this.strings.reset_title,
      body: fmt(this.strings.reset_body, { count: this.state.snacks.length }),
      confirm: this.strings.reset_confirm,
      cancel: this.strings.keep_box,
    });
    if (!ok) return;

    this.state.snacks = [];
    this.focusTarget = { type: "title" };
    this.commit(this.strings.cleared_announce);
  }

  async changeSize(handle) {
    const next = this.sizes.find((size) => size.handle === handle);
    if (!next || !next.available || next.handle === this.state.size) {
      this.render();
      return;
    }

    if (next.slots < this.state.snacks.length) {
      const remove = this.state.snacks.length - next.slots;
      const ok = await this.confirm({
        title: fmt(this.strings.switch_title, { size: next.title }),
        body: fmt(this.strings.switch_body, {
          capacity: next.slots,
          picked: this.state.snacks.length,
          remove,
        }),
        confirm: this.strings.switch_confirm,
        cancel: this.strings.keep_box,
      });
      if (!ok) {
        this.render(); // puts the radio back on the current size
        return;
      }
      this.state.snacks = this.state.snacks.slice(0, next.slots);
    }

    this.state.size = next.handle;
    this.commit(
      fmt(this.strings.switched_announce, {
        size: next.title,
        filled: this.state.snacks.length,
        total: next.slots,
      }),
    );
  }

  /** Native <dialog> for confirmations. Resolves true only on the confirm button. */
  confirm({ title, body, confirm, cancel }) {
    const { dialog } = this.refs;
    if (!dialog || typeof dialog.showModal !== "function") {
      return Promise.resolve(window.confirm(`${title}\n\n${body}`));
    }

    dialog.querySelector("[data-dialog-title]").textContent = title;
    dialog.querySelector("[data-dialog-body]").textContent = body;
    dialog.querySelector("[data-dialog-confirm]").textContent = confirm;
    dialog.querySelector("[data-dialog-cancel]").textContent = cancel;
    dialog.returnValue = "";

    return new Promise((resolve) => {
      dialog.addEventListener(
        "close",
        () => resolve(dialog.returnValue === "confirm"),
        { once: true },
      );
      dialog.showModal();
    });
  }

  /* ---------- variant picker ---------- */

  /** Resolves with the chosen variant id, or null if the shopper cancelled. */
  chooseVariant(card) {
    const { chooser } = this.refs;
    if (!chooser || typeof chooser.showModal !== "function")
      return Promise.resolve(null);

    chooser.querySelector("[data-chooser-title]").textContent = card.title;
    const group = chooser.querySelector("[data-chooser-options]");
    for (const old of group.querySelectorAll(".crumb-build__chooser-option"))
      old.remove();

    let firstEnabled = null;
    for (const variant of card.variants) {
      const label = document.createElement("label");
      label.className = "crumb-build__chooser-option";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "crumb-variant";
      input.value = String(variant.id);
      input.disabled = !variant.available;

      const name = document.createElement("span");
      name.className = "crumb-build__chooser-name";
      name.textContent = variant.title;

      const price = document.createElement("span");
      price.textContent = variant.available
        ? variant.price
        : this.strings.choose_sold_out;

      label.append(input, name, price);
      group.append(label);
      if (!firstEnabled && variant.available) firstEnabled = input;
    }
    if (firstEnabled) firstEnabled.checked = true;

    chooser.returnValue = "";
    return new Promise((resolve) => {
      chooser.addEventListener(
        "close",
        () => {
          if (chooser.returnValue !== "confirm") {
            resolve(null);
            return;
          }
          const checked = group.querySelector("input:checked");
          resolve(checked ? checked.value : null);
        },
        { once: true },
      );
      chooser.showModal();
    });
  }

  async openChooser(card) {
    if (this.isFull) {
      this.announce(this.strings.full_hint);
      return;
    }
    const variantId = await this.chooseVariant(card);
    if (!variantId || !this.isPickable(variantId) || this.isFull) return;
    this.addItem(variantId, "choose");
  }

  /* ---------- add to cart ---------- */

  buildProperties() {
    const properties = {};
    this.state.snacks.forEach((id, index) => {
      const item = this.items.get(id);
      // Readable line for the shopper: "Slot 1": "Choco Almond Clusters"
      properties[fmt(this.strings.slot_property, { number: index + 1 })] = item
        ? item.title
        : id;
    });
    // Underscore properties are hidden at checkout and in the cart: kept for fulfilment.
    properties._snacks = this.state.snacks.join(",");
    return properties;
  }

  dipActive(size) {
    const min = Number(this.dataset.dipMin) || 0;
    return Boolean(this.dataset.dipVariant) && size.slots >= min;
  }

  /** Lets the header cart count update, using the theme's own cart event. Optional: never blocks adding. */
  async prepareCartEvent(items) {
    try {
      const { CartLinesUpdateEvent } = await import("@shopify/events");
      const deferred = CartLinesUpdateEvent.createPromise();

      this.dispatchEvent(
        new CartLinesUpdateEvent({
          action: "add",
          context: "product",
          lines: items.map((item) => ({
            merchandiseId: String(item.id),
            quantity: item.quantity,
          })),
          promise: deferred.promise,
        }),
      );

      return {
        resolve: async () => {
          try {
            const response = await fetch(`${this.dataset.cartUrl}.js`, {
              headers: { Accept: "application/json" },
            });
            const cart = await response.json();
            deferred.resolve({
              cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
              detail: {
                items: cart.items,
                source: "crumb-build-box",
                sourceId: this.id || "crumb-build-box",
                itemCount: 1,
                sections: {},
                didError: false,
              },
            });
          } catch (error) {
            deferred.reject(error);
          }
        },
        reject: (error) => deferred.reject(error),
      };
    } catch (error) {
      return null;
    }
  }

  /** Not-ready button: bring the shopper to the snacks instead of doing nothing. */
  scrollToCatalog() {
    const { catalog } = this.refs;
    if (!catalog) return;
    const reduce =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    catalog.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "start",
    });
  }

  async addToCart() {
    const size = this.size;
    if (this.adding || !size) return;
    if (!this.isFull) {
      this.scrollToCatalog();
      return;
    }

    this.adding = true;
    this.setError("");
    this.refs.success.hidden = true;
    this.render();

    const items = [
      {
        id: Number(size.variantId),
        quantity: 1,
        properties: this.buildProperties(),
      },
    ];
    if (this.dipActive(size))
      items.push({ id: Number(this.dataset.dipVariant), quantity: 1 });

    const cartEvent = await this.prepareCartEvent(items);

    try {
      const response = await fetch(this.dataset.cartAddUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ items }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status) {
        throw new Error(
          data.description || data.message || this.strings.add_error,
        );
      }

      if (cartEvent) await cartEvent.resolve();

      this.state.snacks = [];
      this.persist();
      this.refs.success.hidden = false;
      this.announce(this.strings.added);
    } catch (error) {
      if (cartEvent) cartEvent.reject(error);
      this.setError(
        error && error.message ? error.message : this.strings.add_error,
      );
    } finally {
      this.adding = false;
      this.render();
    }
  }

  /* ---------- rendering ---------- */

  render() {
    const size = this.size;
    const { refs, strings } = this;

    for (const item of this.sizes)
      item.input.checked = Boolean(size) && item.handle === size.handle;
    if (!size) return;

    const filled = this.state.snacks.length;
    const total = size.slots;
    const remaining = total - filled;
    const percent = Math.round((filled / total) * 100);
    const filledText = fmt(strings.filled, { filled, total });

    refs.trayTitle.textContent = fmt(strings.tray_title, { size: size.title });
    refs.trayNumber.textContent = String(total);
    refs.badge.textContent = filledText;
    refs.selected.textContent = fmt(strings.slots_selected, { filled, total });
    refs.packed.textContent = fmt(strings.packed, { percent });
    refs.percent.textContent = fmt(strings.complete, { percent });

    refs.progress.setAttribute("aria-valuemax", String(total));
    refs.progress.setAttribute("aria-valuenow", String(filled));
    refs.progress.setAttribute("aria-valuetext", filledText);
    refs.progress.style.setProperty("--crumb-build-progress", `${percent}%`);

    refs.progressText.textContent =
      remaining > 0
        ? remaining === 1
          ? strings.fill_more_one
          : fmt(strings.fill_more_other, { remaining })
        : strings.box_full;

    refs.alert.textContent =
      remaining > 0
        ? remaining === 1
          ? strings.alert_one
          : fmt(strings.alert_other, { remaining })
        : strings.alert_full;

    this.renderSlots(size);
    this.renderCards();
    this.renderSummary(size, filled, total, remaining);

    refs.fullHint.textContent = this.isFull ? strings.full_hint : "";
  }

  renderSlots(size) {
    const { slots } = this.refs;
    const { strings } = this;
    slots.textContent = "";

    for (let index = 0; index < size.slots; index += 1) {
      const entry = this.state.snacks[index];
      const item = entry ? this.items.get(entry) : null;
      const slot = document.createElement("li");

      if (item) {
        slot.className = "crumb-build__slot crumb-build__slot--filled";

        const media = document.createElement("span");
        media.className = "crumb-build__slot-media";
        if (item.image) {
          const image = document.createElement("img");
          image.src = item.image;
          image.alt = "";
          image.width = 80;
          image.height = 80;
          media.append(image);
        }

        const info = document.createElement("span");
        info.className = "crumb-build__slot-info";

        const name = document.createElement("span");
        name.className = "crumb-build__slot-name";
        name.textContent = item.title;

        const price = document.createElement("span");
        price.className = "crumb-build__slot-price";
        price.textContent = item.priceText;

        info.append(name, price);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "crumb-build__slot-remove";
        remove.dataset.removeSlot = "";
        remove.dataset.index = String(index);
        remove.setAttribute(
          "aria-label",
          fmt(strings.remove_from_slot, {
            title: item.title,
            number: index + 1,
          }),
        );
        const cross = document.createElement("span");
        cross.setAttribute("aria-hidden", "true");
        cross.textContent = "×";
        remove.append(cross);

        slot.append(media, info, remove);
      } else {
        slot.className = "crumb-build__slot crumb-build__slot--empty";

        const plus = document.createElement("span");
        plus.className = "crumb-build__slot-plus";
        plus.setAttribute("aria-hidden", "true");
        plus.textContent = "+";

        const label = document.createElement("span");
        label.className = "crumb-build__slot-label";
        label.textContent = fmt(strings.slot, { number: index + 1 });

        // "Open" shows on desktop, "Available" on mobile (CSS picks one)
        const open = document.createElement("span");
        open.className = "crumb-build__slot-open";
        open.textContent = ` ${strings.slot_open}`;
        label.append(open);

        const available = document.createElement("span");
        available.className = "crumb-build__slot-available";
        available.textContent = strings.slot_available;

        slot.append(plus, label, available);
      }

      slots.append(slot);
    }
  }

  renderCards() {
    const full = this.isFull;
    const counts = new Map();
    for (const id of this.state.snacks) {
      const item = this.items.get(id);
      if (!item) continue;
      counts.set(item.card.handle, (counts.get(item.card.handle) || 0) + 1);
    }

    for (const card of this.cards.values()) {
      const count = counts.get(card.handle) || 0;

      if (card.pickable && card.add && card.stepper) {
        card.add.hidden = count > 0;
        card.stepper.hidden = count === 0;
        card.count.textContent = fmt(this.strings.in_box, { count });
        card.add.setAttribute("aria-disabled", full ? "true" : "false");
        card.increase.setAttribute("aria-disabled", full ? "true" : "false");
      } else if (card.choosable && card.choose) {
        card.choose.setAttribute("aria-disabled", full ? "true" : "false");
        if (card.chooseCount) {
          card.chooseCount.hidden = count === 0;
          card.chooseCount.textContent =
            count > 0 ? fmt(this.strings.in_box, { count }) : "";
        }
      }
    }
  }

  renderSummary(size, filled, total, remaining) {
    const { refs, strings } = this;
    const hasSaving = size.savePct > 0;

    refs.picked.textContent = fmt(strings.picked, { filled, total });
    refs.price.textContent = size.priceText;
    refs.tierPrice.textContent = size.priceText;
    refs.sizeName.textContent = fmt(strings.box_format_value, {
      title: size.title,
      count: total,
    });

    refs.baseInline.hidden = !hasSaving;
    refs.baseInline.textContent = hasSaving ? size.baseText : "";
    refs.baseRow.hidden = !hasSaving;
    refs.base.textContent = hasSaving ? size.baseText : "";
    refs.discountRow.hidden = !hasSaving;
    refs.discountTag.textContent = hasSaving
      ? fmt(strings.save_tag, { percent: size.savePct })
      : "";
    refs.saveInline.hidden = !hasSaving;
    refs.saveInline.textContent = hasSaving
      ? fmt(strings.save_inline, { percent: size.savePct })
      : "";

    if (refs.dips.length) {
      const min = Number(this.dataset.dipMin) || 0;
      const title = this.dataset.dipTitle || "";
      const unlocked = size.slots >= min;
      for (const banner of refs.dips) {
        banner.classList.toggle("is-unlocked", unlocked);
        banner.querySelector("[data-dip-title]").textContent = fmt(
          strings.dip_title,
          { title },
        );
        banner.querySelector("[data-dip-text]").textContent = unlocked
          ? strings.dip_text_unlocked
          : fmt(strings.dip_text_locked, { count: min });
      }
    }

    let label = strings.cta_add;
    if (this.adding) label = strings.cta_adding;
    else if (remaining === 1) label = strings.cta_fill_one;
    else if (remaining > 1) label = fmt(strings.cta_fill_other, { remaining });

    refs.ctaLabel.textContent = label;
    // aria-disabled (not disabled) so keyboard focus is not lost while the state changes
    refs.cta.setAttribute(
      "aria-disabled",
      remaining > 0 || this.adding ? "true" : "false",
    );
    refs.cta.setAttribute("aria-busy", this.adding ? "true" : "false");
  }

  /* ---------- focus and announcements ---------- */

  applyFocus() {
    const target = this.focusTarget;
    this.focusTarget = null;
    if (!target) return;

    if (target.type === "increase") {
      const card = this.cards.get(target.handle);
      if (card && card.increase) card.increase.focus();
    } else if (target.type === "add") {
      const card = this.cards.get(target.handle);
      const button = card && (card.add || card.choose);
      if (button) button.focus();
    } else if (target.type === "slot") {
      const buttons = [
        ...this.refs.slots.querySelectorAll("[data-remove-slot]"),
      ];
      const next = buttons.find(
        (button) => Number(button.dataset.index) === target.index,
      );
      const fallback = buttons[buttons.length - 1];
      (next || fallback || this.refs.trayTitle).focus();
    } else if (target.type === "title") {
      this.refs.trayTitle.focus();
    }
  }

  announce(message) {
    const { live } = this.refs;
    live.textContent = "";
    window.setTimeout(() => {
      live.textContent = message;
    }, 50);
  }

  showNotice(message) {
    this.refs.notice.textContent = message || "";
    this.refs.notice.hidden = !message;
  }

  setError(message) {
    this.refs.error.textContent = message || "";
    this.refs.error.hidden = !message;
  }
}

if (!customElements.get("crumb-build-box")) {
  customElements.define("crumb-build-box", CrumbBuildBox);
}

// shared.js - общие константы и утилиты для popup/content scripts
(function initShared(global) {
  const DEFAULT_SETTINGS = {
    scrollSelector: 'div.Profile.custom-scroll.with-notch.Transition_slide.Transition_slide-active, div.flexscroll',
    linkSelectors: ['a.site-name.word-break-all', 'a.site-name'],
    scrollStep: 300,
    scrollDelay: 800,
    inactivityTimeout: 120000,
    maxSteps: 0,
    retryAttempts: 3,
    retryDelay: 1000
  };

  const CHAT_TITLE_SELECTOR = 'h3[dir="auto"][role="button"].fullName.AS54Cntu.vr53L_9p';

  function safeParseJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractPhoneFromPath(input) {
    if (!input) return null;

    const value = String(input).trim();
    if (!value) return null;

    const direct = value.match(/^\+?\d{5,15}$/);
    if (direct) {
      return `+${direct[0].replace(/^\+/, '')}`;
    }

    let pathname = value;
    try {
      pathname = new URL(value, location.origin).pathname || value;
    } catch {
      // Оставляем исходную строку
    }

    const match = pathname.match(/\+?\d{5,15}/);
    if (!match) return null;
    return `+${match[0].replace(/^\+/, '')}`;
  }

  function normalizeLink(input) {
    if (!input) return null;
    const raw = String(input).trim();
    if (!raw) return null;

    const phone = extractPhoneFromPath(raw);
    if (phone) {
      return { type: 'number', number: phone };
    }

    try {
      const url = new URL(raw, 'https://web.telegram.org');

      if (/^mailto:|^tel:/i.test(url.protocol)) {
        return null;
      }

      if (!/^https?:$/i.test(url.protocol)) {
        return null;
      }

      url.hash = '';

      if (url.hostname.includes('t.me') || url.hostname.includes('telegram.me') || url.hostname.includes('web.telegram.org')) {
        const clean = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
        return clean ? { type: 'link', link: clean } : null;
      }

      return { type: 'link', link: url.toString().replace(/\/+$/, '') };
    } catch {
      return null;
    }
  }

  function generateSelector(element) {
    if (!(element instanceof Element)) return null;

    if (element.id) {
      return `${element.tagName.toLowerCase()}#${CSS.escape(element.id)}`;
    }

    const classes = Array.from(element.classList || []).filter(Boolean);
    if (classes.length > 0) {
      return `${element.tagName.toLowerCase()}.${classes.slice(0, 3).map((cls) => CSS.escape(cls)).join('.')}`;
    }

    return element.tagName.toLowerCase();
  }

  function generalizeSelector(selector) {
    if (!selector || typeof selector !== 'string') return selector;

    return selector
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        return part
          .replace(/\.[A-Za-z_][\w-]*(?:_[A-Za-z0-9-]+)?/g, '')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      })
      .filter(Boolean)
      .join(', ');
  }

  global.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  global.CHAT_TITLE_SELECTOR = CHAT_TITLE_SELECTOR;
  global.safeParseJson = safeParseJson;
  global.wait = wait;
  global.extractPhoneFromPath = extractPhoneFromPath;
  global.normalizeLink = normalizeLink;
  global.generateSelector = generateSelector;
  global.generalizeSelector = generalizeSelector;
})(typeof window !== 'undefined' ? window : globalThis);

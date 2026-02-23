// shared.js - Общие константы и утилиты

// Защита от повторной загрузки
if (typeof window.SHARED_LOADED === 'undefined') {
  window.SHARED_LOADED = true;

  window.DEFAULT_SETTINGS = {
    scrollSelector: 'div.Profile.custom-scroll.with-notch.Transition_slide.Transition_slide-active, div.flexscroll',
    linkSelectors: ['a.site-name.word-break-all', 'a.site-name'],
    scrollStep: 300,
    scrollDelay: 800,
    inactivityTimeout: 120000,
    maxSteps: 0,
    retryAttempts: 3,
    retryDelay: 1000
  };

  window.CHAT_TITLE_SELECTOR = 'h3[dir="auto"][role="button"].fullName.AS54Cntu.vr53L_9p';

  // Нормализация ссылки (убираем разницу http/https, www)
  window.normalizeUrl = function(url) {
  try {
    const parsed = new URL(url);
    // Приводим к единому формату: https, без www, без trailing slash
    let normalized = parsed.href
      .replace(/^http:/, 'https:')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/$/, '');
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^http:/, 'https:').replace(/\/$/, '');
  }
}

// Нормализация ссылки для Telegram
window.normalizeLink = function(rawValue) {
  const value = rawValue.trim();
  if (!value) return null;

  // Полная URL
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname === 't.me' || url.hostname === 'telegram.me' || url.hostname === 'www.t.me') {
        const number = window.extractPhoneFromPath(url.pathname);
        if (number) {
          return { type: 'number', number };
        }
        const segments = url.pathname.split('/').filter(Boolean);
        const username = segments[0] || '';
        const lower = username.toLowerCase();
        if (!username) return null;
        // Чёрный список: пропускаем ботов
        if (lower.includes('bot') || lower.endsWith('_bot')) return null;
        // После username не должно быть дополнительных сегментов
        const hasExtraPath = segments.length > 1;
        const hasTrailingSlash = url.pathname.endsWith('/') && segments.length > 0;
        if (hasExtraPath || url.search || url.hash) return null;
        // Нормализуем к единому формату
        const normalizedLink = `https://t.me/${lower}`;
        return { type: 'link', link: normalizedLink, normalized: normalizedLink };
      }
    } catch {
      return null;
    }
    return null;
  }

  // Короткая форма t.me/username
  if (value.startsWith('t.me/') || value.startsWith('telegram.me/')) {
    const normalized = `https://${value}`;
    try {
      const url = new URL(normalized);
      const number = window.extractPhoneFromPath(url.pathname);
      if (number) return { type: 'number', number };
      const segments = url.pathname.split('/').filter(Boolean);
      const username = segments[0] || '';
      const lower = username.toLowerCase();
      if (!username) return null;
      if (lower.includes('bot') || lower.endsWith('_bot')) return null;
      const hasExtraPath = segments.length > 1;
      if (hasExtraPath || url.search || url.hash) return null;
      const normalizedLink = `https://t.me/${lower}`;
      return { type: 'link', link: normalizedLink, normalized: normalizedLink };
    } catch {
      return null;
    }
  }

  // @username формат
  if (value.startsWith('@')) {
    const username = value.slice(1).trim();
    const lower = username.toLowerCase();
    if (!username) return null;
    if (lower.includes('bot') || lower.endsWith('_bot')) return null;
    const normalizedLink = `https://t.me/${lower}`;
    return { type: 'link', link: normalizedLink, normalized: normalizedLink };
  }

  return null;
}

window.extractPhoneFromPath = function(pathname) {
  const match = pathname.match(/^\/\+(\d{5,20})/);
  if (!match) return null;
  return `+${match[1]}`;
}

window.safeParseJson = function(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

window.wait = function(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Полифилл для CSS.escape()
if (window.CSS && !CSS.escape) {
  CSS.escape = function(value) {
    if (arguments.length === 0) {
      throw new TypeError('`CSS.escape` requires an argument.');
    }
    const string = String(value);
    const length = string.length;
    let index = -1;
    let codeUnit;
    let result = '';
    while (++index < length) {
      codeUnit = string.charCodeAt(index);
      if (codeUnit === 0x0000) {
        result += '\uFFFD';
      } else if (
        (codeUnit >= 0x0001 && codeUnit <= 0x001F) ||
        codeUnit === 0x007F
      ) {
        result += '\\' + codeUnit.toString(16) + ' ';
      } else if (
        codeUnit >= 0x0080 ||
        codeUnit === 0x002D ||
        codeUnit === 0x005F
      ) {
        result += string.charAt(index);
      } else if (
        codeUnit >= 0x0030 && codeUnit <= 0x0039
      ) {
        if (index === 0) {
          result += '\\\\' + string.charAt(index);
        } else {
          result += string.charAt(index);
        }
      } else if (
        codeUnit === 0x002B ||
        codeUnit === 0x003C ||
        codeUnit === 0x003E ||
        codeUnit === 0x0021 ||
        codeUnit === 0x0022 ||
        codeUnit === 0x0023 ||
        codeUnit === 0x0024 ||
        codeUnit === 0x0025 ||
        codeUnit === 0x0026 ||
        codeUnit === 0x0027 ||
        codeUnit === 0x002A ||
        codeUnit === 0x002C ||
        codeUnit === 0x002E ||
        codeUnit === 0x003A ||
        codeUnit === 0x003B ||
        codeUnit === 0x003D ||
        codeUnit === 0x003F ||
        codeUnit === 0x0040 ||
        codeUnit === 0x005B ||
        codeUnit === 0x005C ||
        codeUnit === 0x005D ||
        codeUnit === 0x005E ||
        codeUnit === 0x0060 ||
        codeUnit === 0x007B ||
        codeUnit === 0x007C ||
        codeUnit === 0x007D
      ) {
        result += '\\' + string.charAt(index);
      } else {
        result += string.charAt(index);
      }
    }
    return result;
  };
}

// Генерация уникального CSS селектора для элемента
window.generateSelector = function(element, maxDepth = 5) {
  if (!element || element === document.body || element === document.documentElement || maxDepth <= 0) {
    return null;
  }

  // Попробуем ID
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  // Попробуем уникальные классы
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/).filter(c => c && !c.includes('hover') && !c.includes('active') && !c.includes('focus'));
    if (classes.length > 0) {
      const selector = element.tagName.toLowerCase() + '.' + classes.map(c => CSS.escape(c)).join('.');
      const matches = document.querySelectorAll(selector);
      if (matches.length === 1) {
        return selector;
      }
      // Если не уникально, добавляем nth-child
      if (matches.length > 1 && element.parentElement) {
        const siblings = Array.from(element.parentElement.children);
        const index = siblings.indexOf(element) + 1;
        return `${selector}:nth-child(${index})`;
      }
    }
  }

  // Fallback: путь от родителя
  const parent = element.parentElement;
  if (parent) {
    const parentSelector = generateSelector(parent, maxDepth - 1); // Уменьшаем глубину рекурсии
    if (parentSelector) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(element) + 1;
      return `${parentSelector} > ${element.tagName.toLowerCase()}:nth-child(${index})`;
    }
  }

  return element.tagName.toLowerCase();
}

// Обобщение селектора: заменяет конкретные числа в nth-child(n) на *
// например: div.scrollable-thumb:nth-child(1) -> div.scrollable-thumb
window.generalizeSelector = function(selector) {
  if (!selector) return selector;
  
  // Убираем :nth-child(n) где n - конкретное число, если есть класс
  // Оставляем только если это единственный способ идентификации
  let generalized = selector;
  
  // Заменяем :nth-child(число) на :nth-child(*) для универсальности
  generalized = generalized.replace(/:nth-child\(\d+\)/g, ':nth-child(*)');
  
  // Также обрабатываем :eq() jQuery-подобный синтаксис
  generalized = generalized.replace(/:eq\(\d+\)/g, '');
  
  return generalized;
}

// Проверка, соответствует ли элемент обобщённому селектору
window.matchesGeneralizedSelector = function(element, generalizedSelector) {
  if (!element || !generalizedSelector) return false;
  
  try {
    // Пробуем прямой матч
    if (element.matches(generalizedSelector)) return true;
    
    // Пробуем обобщённую версию
    const generalized = window.generalizeSelector(generalizedSelector);
    if (element.matches(generalized)) return true;
    
    // Для nth-child(*) пробуем любой nth-child
    if (generalizedSelector.includes('nth-child(*)')) {
      const baseSelector = generalizedSelector.replace(':nth-child(*)', '');
      if (element.matches(baseSelector)) return true;
    }
    
    return false;
  } catch (e) {
    return false;
  }
}

// Экспорт для использования в других скриптах (для ES modules будет работать в service worker)
if (typeof globalThis !== 'undefined') {
  globalThis.SHARED = {
    DEFAULT_SETTINGS: window.DEFAULT_SETTINGS,
    CHAT_TITLE_SELECTOR: window.CHAT_TITLE_SELECTOR,
    normalizeUrl: window.normalizeUrl,
    normalizeLink: window.normalizeLink,
    extractPhoneFromPath: window.extractPhoneFromPath,
    safeParseJson: window.safeParseJson,
    wait: window.wait,
    generateSelector: window.generateSelector,
    generalizeSelector: window.generalizeSelector,
    matchesGeneralizedSelector: window.matchesGeneralizedSelector
  };
}
} // Закрываем if (typeof window.SHARED_LOADED === 'undefined')

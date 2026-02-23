// Импортируем функции из shared.js через window (content scripts)
const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {
  scrollSelector: "div.Profile.custom-scroll.with-notch.Transition_slide.Transition_slide-active, div.flexscroll",
  linkSelectors: ["a.site-name.word-break-all", "a.site-name"],
  scrollStep: 300,
  scrollDelay: 800,
  inactivityTimeout: 120000,
  maxSteps: 0,
  retryAttempts: 3,
  retryDelay: 1000
};

const CHAT_TITLE_SELECTOR = window.CHAT_TITLE_SELECTOR || 'h3[dir="auto"][role="button"].fullName.AS54Cntu.vr53L_9p';

const normalizeLink = window.normalizeLink || (() => null);
const extractPhoneFromPath = window.extractPhoneFromPath || (() => null);
const safeParseJson = window.safeParseJson || (() => null);
const wait = window.wait || ((ms) => new Promise(r => setTimeout(r, ms)));
const generateSelector = window.generateSelector || ((el) => el?.tagName?.toLowerCase() || null);
const sanitizeSettings = window.sanitizeSettings || ((settings) => settings);
const DEFAULT_SELECTOR_PROFILES = window.DEFAULT_SELECTOR_PROFILES || [];

let activeSelectorProfile = 'manual';
let selectorConfidence = 0;

let isRunning = false;
let isPaused = false;
let stopRequested = false;
let currentSettings = { ...DEFAULT_SETTINGS };
let linkSet = new Set();
let numberSet = new Set();
let logBuffer = [];
let duplicateMap = {};
let duplicateUniqueCount = 0;
// Оптимизация: объединённый буфер для batch saving
let pendingBatchSave = null;
let pendingLogSave = null;
let isCollectionRunning = false;

// Статистика сбора
let stats = {
  newLinks: 0,
  steps: 0
};

// Переменные для picker'а селекторов
let isPickingSelector = false;
let pickerCallbackType = null;
let pickerOverlay = null;
let pickerSelectionBox = null;
let pickerDragStart = null;

// Throttle для логов - не чаще 1 раза в 2 секунды
let lastLogTime = 0;
const LOG_THROTTLE_MS = 2000;

function pushLog(message, level = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  logBuffer.push(entry);
  if (logBuffer.length > 500) {
    logBuffer = logBuffer.slice(-500);
  }
  
  // Throttle уведомлений popup - только при существенных событиях или раз в 2 сек
  const now = Date.now();
  const isImportant = level === 'error' || level === 'success' || message.includes('Итого') || message.includes('завершён');
  
  if (isImportant || now - lastLogTime > LOG_THROTTLE_MS) {
    lastLogTime = now;
    scheduleBatchSave(true); // Принудительно сохраняем с уведомлением
  } else {
    scheduleBatchSave(false); // Сохраняем молча
  }
}

// Batch save - объединяем все операции в одну
function saveAllData(notifyPopup = false) {
  const data = {
    links: Array.from(linkSet),
    numbers: Array.from(numberSet),
    duplicateMap,
    duplicateUniqueCount,
    logs: logBuffer,
    selectorProfileName: activeSelectorProfile,
    selectorConfidence
  };
  
  chrome.storage.local.set(data, () => {
    if (notifyPopup) {
      chrome.runtime.sendMessage({ type: "STATE_UPDATED" }).catch(() => {});
    }
  });
}

function scheduleBatchSave(notifyPopup = false) {
  if (pendingBatchSave) return;
  pendingBatchSave = setTimeout(() => {
    pendingBatchSave = null;
    saveAllData(notifyPopup);
  }, 1000); // Сохраняем раз в секунду вместо 500-800мс
}

// Убраны отдельные saveLinks, saveNumbers, saveDuplicates - всё в batch

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        "links",
        "numbers",
        "duplicates",
        "duplicateMap",
        "duplicateUniqueCount",
        "logs",
        "settings",
        "settingsJson",
        "selectorProfileName",
        "selectorConfidence"
      ],
      (res) => {
      linkSet = new Set(res.links || []);
      numberSet = new Set(res.numbers || []);
      duplicateMap = res.duplicateMap || {};
      duplicateUniqueCount =
        res.duplicateUniqueCount || Object.keys(duplicateMap).length;
      logBuffer = res.logs || [];
      const fromJson = res.settingsJson ? safeParseJson(res.settingsJson) : null;
      currentSettings = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...(res.settings || {}),
        ...(fromJson || {})
      });
      activeSelectorProfile = res.selectorProfileName || 'manual';
      selectorConfidence = Number(res.selectorConfidence) || 0;
      resolve();
      }
    );
  });
}

// Функция принудительного завершающего сохранения
function flushAllData() {
  if (pendingBatchSave) {
    clearTimeout(pendingBatchSave);
    pendingBatchSave = null;
  }
  saveAllData(true);
}

// Throttle для updateChatTitle - не чаще 1 раза в 5 секунд
let lastChatTitleUpdate = 0;
const CHAT_TITLE_THROTTLE_MS = 5000;

function updateChatTitle() {
  const now = Date.now();
  if (now - lastChatTitleUpdate < CHAT_TITLE_THROTTLE_MS) return;
  lastChatTitleUpdate = now;
  
  try {
    const el = document.querySelector(CHAT_TITLE_SELECTOR);
    const title = el?.textContent?.trim();
    if (!title) return;
    chrome.storage.local.set({ chatTitle: title }, () => {
      // Не отправляем STATE_UPDATED здесь - это делает batch save
    });
  } catch (e) {
    // Игнорируем ошибки
  }
}

// Удалены старые scheduleSave* - теперь используется единый batch save

function collectLinks() {
  const selectors = currentSettings.linkSelectors || [];
  let newCount = 0;
  let newNumbers = 0;
  let dupCount = 0;
  
  selectors.forEach((selector) => {
    if (!selector) return;
    
    // Пробуем прямой селектор
    let elements;
    try {
      elements = document.querySelectorAll(selector);
    } catch (e) {
      // Если прямой селектор не работает, пробуем обобщённый
      const generalized = window.generalizeSelector(selector);
      if (generalized !== selector) {
        try {
          elements = document.querySelectorAll(generalized);
        } catch (e2) {
          elements = [];
        }
      } else {
        elements = [];
      }
    }
    
    elements.forEach((el) => {
      const candidates = [];
      const href = el.getAttribute("href") || el.href;
      if (href) {
        candidates.push(href);
      }
      const text = el.textContent?.trim();
      if (text) {
        candidates.push(text);
      }
      candidates
        .map((value) => normalizeLink(value))
        .filter(Boolean)
        .forEach((item) => {
          if (item.type === "number") {
            if (!numberSet.has(item.number)) {
              numberSet.add(item.number);
              newNumbers += 1;
            }
            return;
          }
          const link = item.link;
          if (!linkSet.has(link)) {
            linkSet.add(link);
            newCount += 1;
          } else {
            dupCount += 1;
            if (!duplicateMap[link]) {
              duplicateUniqueCount += 1;
              duplicateMap[link] = 1;
            } else {
              duplicateMap[link] += 1;
            }
          }
        });
    });
  });
  // Логируем только при значимых изменениях (throttled)
  if (newCount > 0 || newNumbers > 0) {
    const parts = [];
    if (newCount > 0) parts.push(`+${newCount} ссылок`);
    if (newNumbers > 0) parts.push(`+${newNumbers} номеров`);
    pushLog(parts.join(', '), "success");
  }
  
  // Сохраняем данные в любом случае - раз в batch
  scheduleBatchSave(false);
  stats.newLinks += newCount;
  return { newCount, dupCount, newNumbers };
}

// Функции normalizeLink, safeParseJson, extractPhoneFromPath, wait уже определены в shared.js


function queryAllSafe(selector, root = document) {
  if (!selector) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function queryOneSafe(selector, root = document) {
  return queryAllSafe(selector, root)[0] || null;
}

function collectValidLinkCount(selectors, root = document) {
  if (!Array.isArray(selectors)) return 0;
  let valid = 0;
  selectors.forEach((selector) => {
    const direct = queryAllSafe(selector, root);
    const generalized = window.generalizeSelector ? window.generalizeSelector(selector) : selector;
    const nodes = direct.length > 0 ? direct : (generalized !== selector ? queryAllSafe(generalized, root) : []);
    nodes.forEach((el) => {
      const href = el.getAttribute('href') || el.href || '';
      const text = el.textContent?.trim() || '';
      if (normalizeLink(href) || normalizeLink(text)) valid += 1;
    });
  });
  return valid;
}

function buildSelectorProfiles(settings) {
  const primary = {
    id: 'user-settings',
    name: 'User settings',
    scrollSelectors: [settings.scrollSelector].filter(Boolean),
    linkSelectors: settings.linkSelectors || []
  };
  const defaults = (DEFAULT_SELECTOR_PROFILES || []).map((profile) => ({
    id: profile.id,
    name: profile.name,
    scrollSelectors: Array.isArray(profile.scrollSelectors) ? profile.scrollSelectors : [],
    linkSelectors: Array.isArray(profile.linkSelectors) ? profile.linkSelectors : []
  }));
  return [primary, ...defaults];
}

function resolveScrollContainer(scrollSelectors) {
  for (const selector of (scrollSelectors || [])) {
    const found = queryOneSafe(selector);
    if (found) return { container: found, selector, generalized: false };
    const generalized = window.generalizeSelector ? window.generalizeSelector(selector) : selector;
    if (generalized && generalized !== selector) {
      const genFound = queryOneSafe(generalized);
      if (genFound) return { container: genFound, selector: generalized, generalized: true };
    }
  }
  return { container: null, selector: null, generalized: false };
}

function evaluateProfile(profile) {
  const scroll = resolveScrollContainer(profile.scrollSelectors);
  if (!scroll.container) return { profile, score: 0, confidence: 0, container: null };
  const validLinks = collectValidLinkCount(profile.linkSelectors, document);
  const score = validLinks * 5 + (scroll.generalized ? 1 : 3);
  const confidence = Math.min(100, Math.max(20, validLinks * 8 + (scroll.generalized ? 5 : 15)));
  return { profile, score, confidence, container: scroll.container, scrollSelector: scroll.selector };
}

function detectHeuristicProfile() {
  const candidates = queryAllSafe('div, section, main').filter((el) => {
    const style = window.getComputedStyle(el);
    const scrollable = ['auto', 'scroll'].includes(style.overflowY) || el.scrollHeight > el.clientHeight * 1.2;
    return scrollable && el.clientHeight > 180;
  }).slice(0, 120);

  let best = null;
  candidates.forEach((container, idx) => {
    const linkSelectors = ['a[href*="t.me/"]', 'a[href*="telegram.me/"]', 'a[href^="https://t.me/"]'];
    const validLinks = collectValidLinkCount(linkSelectors, container);
    const score = validLinks * 6 + Math.min(10, Math.floor(container.clientHeight / 120));
    if (!best || score > best.score) {
      best = {
        score,
        validLinks,
        container,
        profile: {
          id: `auto-${idx + 1}`,
          name: 'Auto-detected',
          scrollSelectors: [],
          linkSelectors
        },
        confidence: Math.min(95, 35 + validLinks * 10)
      };
    }
  });

  if (!best || best.score < 12) return null;
  return best;
}

function chooseWorkingProfile(settings) {
  const profiles = buildSelectorProfiles(settings);
  const evaluations = profiles.map(evaluateProfile).sort((a, b) => b.score - a.score);
  const winner = evaluations[0];
  if (winner && winner.container && winner.score >= 5) {
    return winner;
  }

  // Если контейнер найден, но ссылок пока мало/нет (частый кейс до прогрузки вкладки),
  // всё равно используем лучший контейнер вместо полного фейла.
  const containerOnlyWinner = evaluations.find((item) => item?.container);
  if (containerOnlyWinner) {
    return {
      ...containerOnlyWinner,
      confidence: Math.max(15, Number(containerOnlyWinner.confidence || 0))
    };
  }

  const heuristic = detectHeuristicProfile();
  if (heuristic) {
    return {
      profile: heuristic.profile,
      score: heuristic.score,
      confidence: heuristic.confidence,
      container: heuristic.container,
      scrollSelector: null
    };
  }
  return null;
}

function applyProfileSelection(selection) {
  if (!selection) return;
  const profile = selection.profile || {};
  if (Array.isArray(profile.linkSelectors) && profile.linkSelectors.length > 0) {
    currentSettings.linkSelectors = profile.linkSelectors;
  }
  if (selection.scrollSelector) {
    currentSettings.scrollSelector = selection.scrollSelector;
  }
  activeSelectorProfile = profile.name || profile.id || 'manual';
  selectorConfidence = Number(selection.confidence || 0);
  chrome.storage.local.set({ selectorProfileName: activeSelectorProfile, selectorConfidence });
}

async function runCollection() {
  if (isRunning) {
    pushLog("Сбор уже запущен", "warn");
    return;
  }
  await loadState();
  isRunning = true;
  stopRequested = false;
  stats = { newLinks: 0, steps: 0 };
  duplicateUniqueCount = duplicateUniqueCount || Object.keys(duplicateMap).length;
  updateChatTitle();
  pushLog("Старт сбора", "info");

  let profileSelection = chooseWorkingProfile(currentSettings);
  const profileSelection = chooseWorkingProfile(currentSettings);
  let container = profileSelection?.container || null;

  if (profileSelection) {
    applyProfileSelection(profileSelection);
    pushLog(`Профиль селекторов: ${activeSelectorProfile} (confidence ${selectorConfidence}%)`, 'info');
  }

  if (!container) {
    pushLog('Контейнер не найден, пробуем открыть вкладку "Ссылки" и повторить', 'warn');
    await clickLinksTab();
    await wait(900);
    profileSelection = chooseWorkingProfile(currentSettings);
    container = profileSelection?.container || null;
    if (profileSelection) {
      applyProfileSelection(profileSelection);
      pushLog(`Профиль селекторов после retry: ${activeSelectorProfile} (confidence ${selectorConfidence}%)`, 'info');
    }

    if (!container) {
      pushLog("Контейнер скролла не найден даже после fallback/auto-detect", "error");
      isRunning = false;
      flushAllData();
      return;
    }
    pushLog("Контейнер скролла не найден даже после fallback/auto-detect", "error");
    isRunning = false;
    flushAllData();
    return;
  }

  let lastScrollTop = container.scrollTop;
  let lastHeight = container.scrollHeight;
  let lastActivityTs = Date.now();

  while (!stopRequested) {
    // Проверка паузы - ждём пока не снимут
    while (isPaused && !stopRequested) {
      await wait(200);
    }
    if (stopRequested) break;

    stats.steps += 1;
    const before = collectLinks();

    container.scrollBy(0, currentSettings.scrollStep);
    await wait(currentSettings.scrollDelay);

    const after = collectLinks();
    const gained = (before?.newCount || 0) + (after?.newCount || 0);

    const heightChanged = container.scrollHeight !== lastHeight;
    const scrollMoved = container.scrollTop !== lastScrollTop;

    lastScrollTop = container.scrollTop;
    lastHeight = container.scrollHeight;
    if (heightChanged || scrollMoved) {
      lastActivityTs = Date.now();
      // Отладочный лог
      if (stats.steps % 10 === 0) { // Логируем каждые 10 шагов
        const changes = [];
        if (heightChanged) changes.push('высота');
        if (scrollMoved) changes.push('скролл');
        pushLog(`Активность: ${changes.join(', ')}`, 'info');
      }
    }

    if (!heightChanged && !scrollMoved && gained === 0 && stats.steps > 5 && stats.steps % 8 === 0) {
      const fallbackSelection = chooseWorkingProfile(currentSettings);
      if (fallbackSelection?.container) {
        applyProfileSelection(fallbackSelection);
        container = fallbackSelection.container;
        pushLog(`Auto-recover: переключение на профиль ${activeSelectorProfile}`, 'warn');
        lastActivityTs = Date.now();
      }
    }

    if (Date.now() - lastActivityTs >= currentSettings.inactivityTimeout) {
      pushLog("Нет движения/изменений — завершение", "info");
      break;
    }

    if (currentSettings.maxSteps > 0 && stats.steps >= currentSettings.maxSteps) {
      pushLog("Достигнут лимит шагов — завершение", "info");
      break;
    }
  }

  if (!stopRequested) {
    await wait(300);
    collectLinks();
  }

  const summary = `Итого: новых ссылок ${stats.newLinks}, шагов ${stats.steps}`;
  pushLog(summary, "info");

  if (stopRequested) {
    pushLog("Сбор остановлен вручную", "info");
  } else {
    pushLog("Сбор завершён", "info");
  }
  
  isRunning = false;
  stopRequested = false;
  isPaused = false;
  
  // Принудительно сохраняем все данные при завершении
  flushAllData();
  
  // Уведомляем background о завершении
  chrome.runtime.sendMessage({ 
    type: "COLLECTION_FINISHED", 
    count: stats.newLinks 
  }).catch(() => {});
}

// === Picker селекторов ===
function startSelectorPicker(callbackType) {
  if (isPickingSelector) {
    stopSelectorPicker();
  }

  isPickingSelector = true;
  pickerCallbackType = callbackType;

  // Создаем overlay для подсветки элементов
  pickerOverlay = document.createElement('div');
  pickerOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 999999;
    background: rgba(0, 255, 0, 0.08);
    display: none;
  `;
  document.body.appendChild(pickerOverlay);

  pickerSelectionBox = document.createElement('div');
  pickerSelectionBox.style.cssText = `
    position: fixed;
    border: 2px dashed #22c55e;
    background: rgba(34, 197, 94, 0.15);
    pointer-events: none;
    z-index: 1000000;
    display: none;
  `;
  document.body.appendChild(pickerSelectionBox);

  // Для scroll selector используем выделение области мышью,
  // для link selector сохраняем прежний точечный click-picker.
  if (callbackType === 'scroll') {
    document.addEventListener('mousedown', pickerMouseDownHandler, true);
    document.addEventListener('mousemove', pickerMouseMoveHandler, true);
    document.addEventListener('mouseup', pickerMouseUpHandler, true);
    pushLog('Выделите мышкой область скролла (зажмите и отпустите)', 'info');
  } else {
    document.addEventListener('mouseover', pickerHoverHandler, true);
    document.addEventListener('mouseout', pickerOutHandler, true);
    document.addEventListener('click', pickerClickHandler, true);
    pushLog(`Picker запущен для: ${callbackType}`, "info");
  }
}

function stopSelectorPicker() {
  isPickingSelector = false;
  pickerCallbackType = null;

  if (pickerOverlay) {
    pickerOverlay.remove();
    pickerOverlay = null;
  }
  if (pickerSelectionBox) {
    pickerSelectionBox.remove();
    pickerSelectionBox = null;
  }
  pickerDragStart = null;

  document.removeEventListener('mouseover', pickerHoverHandler, true);
  document.removeEventListener('mouseout', pickerOutHandler, true);
  document.removeEventListener('click', pickerClickHandler, true);
  document.removeEventListener('mousedown', pickerMouseDownHandler, true);
  document.removeEventListener('mousemove', pickerMouseMoveHandler, true);
  document.removeEventListener('mouseup', pickerMouseUpHandler, true);

  document.querySelectorAll('[data-picker-highlight]').forEach(el => {
    el.style.outline = '';
    el.removeAttribute('data-picker-highlight');
  });
}


function isScrollableElement(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY;
  const canScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  return canScroll || el.scrollHeight > el.clientHeight + 20;
}

function findBestScrollableFromRect(rect) {
  if (!rect) return null;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let node = document.elementFromPoint(cx, cy);
  while (node) {
    if (isScrollableElement(node)) return node;
    node = node.parentElement;
  }

  const candidates = Array.from(document.querySelectorAll('div, section, main, aside, article'));
  let best = null;
  let bestScore = -1;
  candidates.forEach((el) => {
    if (!isScrollableElement(el)) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.right, r.right) - Math.max(rect.left, r.left));
    const y = Math.max(0, Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top));
    const overlap = x * y;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = el;
    }
  });
  return best;
}

function pickerMouseDownHandler(e) {
  if (!isPickingSelector || pickerCallbackType !== 'scroll') return;
  e.preventDefault();
  e.stopPropagation();
  pickerDragStart = { x: e.clientX, y: e.clientY };
  if (pickerSelectionBox) {
    pickerSelectionBox.style.display = 'block';
    pickerSelectionBox.style.left = `${e.clientX}px`;
    pickerSelectionBox.style.top = `${e.clientY}px`;
    pickerSelectionBox.style.width = '0px';
    pickerSelectionBox.style.height = '0px';
  }
}

function pickerMouseMoveHandler(e) {
  if (!isPickingSelector || pickerCallbackType !== 'scroll' || !pickerDragStart || !pickerSelectionBox) return;
  e.preventDefault();
  e.stopPropagation();
  const left = Math.min(pickerDragStart.x, e.clientX);
  const top = Math.min(pickerDragStart.y, e.clientY);
  const width = Math.abs(e.clientX - pickerDragStart.x);
  const height = Math.abs(e.clientY - pickerDragStart.y);
  pickerSelectionBox.style.left = `${left}px`;
  pickerSelectionBox.style.top = `${top}px`;
  pickerSelectionBox.style.width = `${width}px`;
  pickerSelectionBox.style.height = `${height}px`;
}

function pickerMouseUpHandler(e) {
  if (!isPickingSelector || pickerCallbackType !== 'scroll' || !pickerDragStart) return;
  e.preventDefault();
  e.stopPropagation();

  const left = Math.min(pickerDragStart.x, e.clientX);
  const top = Math.min(pickerDragStart.y, e.clientY);
  const width = Math.max(4, Math.abs(e.clientX - pickerDragStart.x));
  const height = Math.max(4, Math.abs(e.clientY - pickerDragStart.y));
  const rect = { left, top, right: left + width, bottom: top + height, width, height };

  const bestScrollable = findBestScrollableFromRect(rect);
  const selector = generateSelector(bestScrollable || document.elementFromPoint(e.clientX, e.clientY));

  if (selector) {
    chrome.runtime.sendMessage({
      type: 'SELECTOR_PICKED',
      selector,
      callbackType: pickerCallbackType
    });
    pushLog(`Выбран scroll-селектор по области: ${selector}`, 'success');
  } else {
    pushLog('Не удалось определить скролл-область', 'error');
  }

  stopSelectorPicker();
}

function pickerHoverHandler(e) {
  if (!isPickingSelector) return;
  e.preventDefault();
  e.stopPropagation();

  const target = e.target;
  if (!target || target === pickerOverlay) return;

  // Подсветка элемента
  target.style.outline = '3px solid #00ff00';
  target.setAttribute('data-picker-highlight', 'true');

  pickerOverlay.style.display = 'block';
  pickerOverlay.textContent = `Элемент: ${target.tagName.toLowerCase()}${target.className ? '.' + target.className.split(' ').join('.') : ''}`;
}

function pickerOutHandler(e) {
  if (!isPickingSelector) return;
  const target = e.target;
  if (target && target.hasAttribute('data-picker-highlight')) {
    target.style.outline = '';
    target.removeAttribute('data-picker-highlight');
  }
}

function pickerClickHandler(e) {
  if (!isPickingSelector) return;
  e.preventDefault();
  e.stopPropagation();

  const target = e.target;
  const selector = generateSelector(target);

  if (selector) {
    chrome.runtime.sendMessage({
      type: 'SELECTOR_PICKED',
      selector,
      callbackType: pickerCallbackType
    });
    pushLog(`Выбран селектор: ${selector}`, "success");
  } else {
    pushLog("Не удалось сгенерировать селектор", "error");
  }

  stopSelectorPicker();
}

// Функция generateSelector используется из shared.js

// Функция для клика на вкладку "Ссылки"
async function clickLinksTab() {
  await wait(2000); // Ждём загрузки страницы

  // Ищем вкладку с текстом "Ссылки" или "Links"
  const tabs = document.querySelectorAll('div.Tab.Tab--interactive');
  for (const tab of tabs) {
    const text = tab.textContent?.trim().toLowerCase();
    if (text === 'ссылки' || text === 'links') {
      tab.click();
      console.log('Кликнули на вкладку "Ссылки"');
      chrome.storage.local.remove('shouldClickLinksTab');
      return;
    }
  }

  console.log('Вкладка "Ссылки" не найдена');
  chrome.storage.local.remove('shouldClickLinksTab');
}

// Проверяем флаг при загрузке страницы
chrome.storage.local.get(['shouldClickLinksTab'], (res) => {
  if (res.shouldClickLinksTab) {
    clickLinksTab();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "START_COLLECTION") {
    runCollection();
  }
  if (message?.type === "STOP_COLLECTION") {
    stopRequested = true;
    isPaused = false;
  }
  if (message?.type === "PAUSE_COLLECTION") {
    isPaused = true;
    pushLog("Сбор на паузе", "info");
  }
  if (message?.type === "RESUME_COLLECTION") {
    isPaused = false;
    pushLog("Сбор возобновлён", "info");
  }
  if (message?.type === "GET_STATUS") {
    chrome.runtime.sendMessage({
      type: 'STATUS_RESPONSE',
      isRunning,
      isPaused
    });
  }
  if (message?.type === "SYNC_CHAT_TITLE") {
    updateChatTitle();
  }
  if (message?.type === "START_SELECTOR_PICKER") {
    startSelectorPicker(message.callbackType);
  }
  if (message?.type === "CHECK_SELECTORS") {
    const { scrollSelector, linkSelectors } = message;

    // Проверка селектора скролла (прямой + обобщённый)
    let scrollFound = false;
    let scrollGeneralized = false;
    let scrollResult = '❌ Не найден';
    
    try {
      scrollFound = !!document.querySelector(scrollSelector);
    } catch (e) {}
    
    const generalized = window.generalizeSelector(scrollSelector);
    if (generalized !== scrollSelector) {
      try {
        scrollGeneralized = !!document.querySelector(generalized);
      } catch (e) {}
    }
      
    if (scrollFound && scrollGeneralized) {
      scrollResult = '✅ Найден (прямой + обобщ.)';
    } else if (scrollFound) {
      scrollResult = '✅ Найден (прямой)';
    } else if (scrollGeneralized) {
      scrollResult = '✅ Найден (обобщ.)';
    } else {
      scrollResult = '❌ Не найден';
    }
    
    // Проверка селекторов ссылок (прямой + обобщённый)
    const linkCounts = {};
    (linkSelectors || []).forEach((selector) => {
      if (!selector) return;
      
      let directCount = 0;
      let generalizedCount = 0;
      let generalized = null;
      
      // Пробуем прямой селектор
      try {
        directCount = document.querySelectorAll(selector).length;
      } catch (e) {}
      
      // Пробуем обобщённый селектор
      generalized = window.generalizeSelector(selector);
      if (generalized !== selector) {
        try {
          generalizedCount = document.querySelectorAll(generalized).length;
        } catch (e) {}
      }
      
      // Формируем результат: показываем оба
      if (generalized && generalized !== selector) {
        linkCounts[selector] = `${directCount} (обобщ: ${generalizedCount})`;
      } else {
        linkCounts[selector] = directCount;
      }
    });
    
    chrome.runtime.sendMessage({
      type: 'SELECTORS_TESTED',
      scrollResult,
      linkCounts
    });
  }
});

// background.js - Service Worker для фоновой работы

// Настройки по умолчанию (копия из shared.js)
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

// === ОПТИМИЗАЦИЯ: Throttle для уменьшения сетевой активности ===
let lastStateUpdateTime = 0;
const STATE_UPDATE_THROTTLE_MS = 1000; // Не чаще 1 раза в секунду
let pendingStateUpdate = null;


function sanitizeSettings(rawSettings) {
  const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const defaults = DEFAULT_SETTINGS;
  const normalizeInt = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.trunc(num);
    if (int < min || int > max) return fallback;
    return int;
  };

  const linkSelectors = Array.isArray(source.linkSelectors)
    ? source.linkSelectors.map((item) => String(item || '').trim()).filter(Boolean)
    : defaults.linkSelectors;

  return {
    scrollSelector: String(source.scrollSelector || defaults.scrollSelector || '').trim(),
    linkSelectors: linkSelectors.length ? linkSelectors : defaults.linkSelectors,
    scrollStep: normalizeInt(source.scrollStep, defaults.scrollStep, 10, 10000),
    scrollDelay: normalizeInt(source.scrollDelay, defaults.scrollDelay, 50, 60000),
    inactivityTimeout: normalizeInt(source.inactivityTimeout, defaults.inactivityTimeout, 1000, 600000),
    maxSteps: normalizeInt(source.maxSteps, defaults.maxSteps, 0, 100000),
    retryAttempts: normalizeInt(source.retryAttempts, defaults.retryAttempts, 0, 20),
    retryDelay: normalizeInt(source.retryDelay, defaults.retryDelay, 0, 30000)
  };
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Состояние сбора
let collectionState = {
  isRunning: false,
  isPaused: false,
  tabId: null,
  linksCount: 0
};

// Инициализация при загрузке
chrome.runtime.onInstalled.addListener(async () => {
  console.log('TG Link Collector установлен');
  await initializeStorage();
  updateBadge(0);
});

// Инициализация хранилища
async function initializeStorage() {
  const local = await chrome.storage.local.get(['links', 'settings']);
  if (!local.links) {
    await chrome.storage.local.set({ links: [], numbers: [], duplicates: [], duplicateMap: {}, logs: [] });
  }
  if (!local.settings) {
    await chrome.storage.local.set({ settings: sanitizeSettings(DEFAULT_SETTINGS) });
  }
  
  // Синхронизация с sync storage
  try {
    const sync = await chrome.storage.sync.get(['settingsBackup']);
    if (sync.settingsBackup && !local.settings) {
      await chrome.storage.local.set({ settings: sanitizeSettings(sync.settingsBackup) });
    }
  } catch (e) {
    console.warn('Sync storage недоступен:', e);
  }
}

// Обновление badge на иконке
function updateBadge(count) {
  collectionState.linksCount = count;
  const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#2563eb' : '#64748b' });
}

// Обновление badge с текущим состоянием
async function refreshBadge() {
  const { links } = await chrome.storage.local.get(['links']);
  updateBadge((links || []).length);
}

// Резервное копирование настроек в sync storage
async function backupSettings(settings) {
  try {
    // Ограничение sync storage: 8KB на элемент
    const settingsStr = JSON.stringify(settings);
    if (settingsStr.length < 8000) {
      await chrome.storage.sync.set({ settingsBackup: sanitizeSettings(settings), lastBackup: Date.now() });
      console.log('Настройки сохранены в облако');
    }
  } catch (e) {
    console.warn('Не удалось сохранить в sync storage:', e);
  }
}

// Восстановление настроек из sync storage
async function restoreSettings() {
  try {
    const sync = await chrome.storage.sync.get(['settingsBackup']);
    if (sync.settingsBackup) {
      const normalized = sanitizeSettings(sync.settingsBackup);
      await chrome.storage.local.set({ settings: normalized });
      return normalized;
    }
  } catch (e) {
    console.warn('Не удалось восстановить из sync storage:', e);
  }
  return null;
}

// Обработка сообщений
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(e => {
    console.error('Ошибка обработки сообщения:', e);
    sendResponse({ error: e.message });
  });
  return true; // Асинхронный ответ
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'STATE_UPDATED':
      // Throttle - игнорируем слишком частые обновления
      const now = Date.now();
      if (now - lastStateUpdateTime < STATE_UPDATE_THROTTLE_MS) {
        return { success: true, throttled: true };
      }
      lastStateUpdateTime = now;
      
      await refreshBadge();
      // Уведомляем popup о обновлении
      try {
        await chrome.runtime.sendMessage({ type: 'STATE_UPDATED' });
      } catch {
        // Popup может быть закрыт
      }
      return { success: true };

    case 'GET_COLLECTION_STATE':
      return collectionState;

    case 'SET_COLLECTION_STATE':
      collectionState = { ...collectionState, ...message.state };
      return collectionState;

    case 'UPDATE_BADGE':
      updateBadge(message.count);
      return { success: true };

    case 'BACKUP_SETTINGS':
      await backupSettings(sanitizeSettings(message.settings));
      return { success: true };

    case 'RESTORE_SETTINGS':
      const restored = await restoreSettings();
      return { success: !!restored, settings: restored };

    case 'START_COLLECTION':
      collectionState.isRunning = true;
      collectionState.isPaused = false;
      collectionState.tabId = sender.tab?.id || message.tabId;
      return { success: true };

    case 'PAUSE_COLLECTION':
      collectionState.isPaused = true;
      return { success: true };

    case 'RESUME_COLLECTION':
      collectionState.isPaused = false;
      return { success: true };

    case 'STOP_COLLECTION':
      collectionState.isRunning = false;
      collectionState.isPaused = false;
      return { success: true };

    case 'COLLECTION_FINISHED':
      collectionState.isRunning = false;
      collectionState.isPaused = false;
      await refreshBadge();
      // Показать уведомление
      try {
        await chrome.notifications.create({
          type: 'basic',
          title: 'Сбор завершён',
          message: `Собрано ссылок: ${message.count || 0}`
        });
      } catch {
        // Уведомления могут быть отключены
      }
      return { success: true };

    case 'LOG_ERROR':
      console.error('Content script error:', message.error);
      return { success: true };

    default:
      return { error: 'Unknown message type' };
  }
}

// Слушаем изменения в storage для обновления badge
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.links) {
    const newLinks = changes.links.newValue || [];
    updateBadge(newLinks.length);
  }
});

// Команды клавиатуры (если настроены в manifest)
chrome.commands?.onCommand?.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  switch (command) {
    case 'start-collection':
      chrome.tabs.sendMessage(tab.id, { type: 'START_COLLECTION' });
      break;
    case 'stop-collection':
      chrome.tabs.sendMessage(tab.id, { type: 'STOP_COLLECTION' });
      break;
    case 'pause-collection':
      chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_COLLECTION' });
      break;
  }
});

// Инициализация badge при старте
refreshBadge();

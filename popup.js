// popup.js - UI логика с поддержкой паузы, sync backup и выбора селекторов

// Используем DEFAULT_SETTINGS из shared.js
const state = {
  links: [],
  numbers: [],
  duplicates: [],
  duplicateMap: {},
  duplicateUniqueCount: 0,
  logs: [],
  settings: { ...(window.DEFAULT_SETTINGS || {}) },
  chatTitle: '',
  isRunning: false,
  isPaused: false
};

// DOM элементы
const $ = (id) => document.getElementById(id);
const statsEl = $('stats');
const statusEl = $('statusIndicator');
const linksListEl = $('linksList');
const numbersListEl = $('numbersList');
const duplicatesListEl = $('duplicatesList');
const logsListEl = $('logsList');
const scrollSelectorEl = $('scrollSelector');
const linkSelectorsEl = $('linkSelectors');
const scrollStepEl = $('scrollStep');
const scrollDelayEl = $('scrollDelay');
const inactivityTimeoutEl = $('inactivityTimeout');
const maxStepsEl = $('maxSteps');
const retryAttemptsEl = $('retryAttempts');
const retryDelayEl = $('retryDelay');

// Кнопки
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const pauseBtn = $('pauseBtn');

// === Throttle для STATE_UPDATED - не обновляем UI чаще чем раз в 500ms ===
let lastStateUpdate = 0;
const STATE_UPDATE_THROTTLE_MS = 500;

// === Утилиты ===
function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeFileName(value) {
  const cleaned = (value || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 80) : '';
}

function buildExportName(kind) {
  const base = sanitizeFileName(state.chatTitle) || 'tg';
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${kind}_${date}.txt`;
}

function getDuplicateDisplayList(map, fallbackList) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) return fallbackList || [];
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([link, count]) => `${link} (x${count})`);
}

function buildDuplicateExport(map, fallbackList) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) return (fallbackList || []).join('\n');
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([link, count]) => `${link}\t${count}`)
    .join('\n');
}

// === UI обновление ===
function updateStats() {
  const dupCount = state.duplicateUniqueCount || Object.keys(state.duplicateMap || {}).length || state.duplicates.length;
  statsEl.textContent = `Ссылок: ${state.links.length} · Номеров: ${state.numbers.length} · Дублей: ${dupCount} · Логи: ${state.logs.length}`;
}

function updateStatus() {
  if (state.isRunning) {
    if (state.isPaused) {
      statusEl.className = 'status-indicator paused';
      statusEl.title = 'На паузе';
      pauseBtn.textContent = 'Продолжить';
      pauseBtn.classList.add('resume');
    } else {
      statusEl.className = 'status-indicator running';
      statusEl.title = 'Сбор идёт';
      pauseBtn.textContent = 'Пауза';
      pauseBtn.classList.remove('resume');
    }
    startBtn.disabled = true;
    stopBtn.disabled = false;
    pauseBtn.disabled = false;
  } else {
    statusEl.className = 'status-indicator idle';
    statusEl.title = 'Готов к работе';
    pauseBtn.textContent = 'Пауза';
    pauseBtn.classList.remove('resume');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    pauseBtn.disabled = true;
  }
}

function renderList(container, items, options = {}) {
  container.innerHTML = '';
  const { reverse = false, limit = null, isLog = false } = options;
  let data = items.slice();
  if (reverse) data = data.reverse();
  if (Number.isFinite(limit)) data = data.slice(0, limit);

  if (data.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-item empty';
    empty.textContent = 'Пусто';
    container.appendChild(empty);
    return;
  }

  data.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    
    if (isLog) {
      // Раскраска логов по уровню
      if (item.includes('ERROR')) div.classList.add('log-error');
      else if (item.includes('WARN')) div.classList.add('log-warn');
      else if (item.includes('SUCCESS')) div.classList.add('log-success');
    }
    
    div.textContent = item;
    container.appendChild(div);
  });
}

function renderSettings() {
  const defaults = window.DEFAULT_SETTINGS || {};
  if (scrollSelectorEl) scrollSelectorEl.value = state.settings.scrollSelector || '';
  if (linkSelectorsEl) linkSelectorsEl.value = (state.settings.linkSelectors || []).join('\n');
  if (scrollStepEl) scrollStepEl.value = state.settings.scrollStep ?? defaults.scrollStep;
  if (scrollDelayEl) scrollDelayEl.value = state.settings.scrollDelay ?? defaults.scrollDelay;
  if (inactivityTimeoutEl) inactivityTimeoutEl.value = state.settings.inactivityTimeout ?? defaults.inactivityTimeout;
  if (maxStepsEl) maxStepsEl.value = state.settings.maxSteps ?? defaults.maxSteps;
  if (retryAttemptsEl) retryAttemptsEl.value = state.settings.retryAttempts ?? defaults.retryAttempts;
  if (retryDelayEl) retryDelayEl.value = state.settings.retryDelay ?? defaults.retryDelay;
}

function readSettingsFromUi() {
  const defaults = window.DEFAULT_SETTINGS || {};
  const linkSelectors = (linkSelectorsEl?.value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  
  return {
    scrollSelector: scrollSelectorEl?.value?.trim() || '',
    linkSelectors,
    scrollStep: Number(scrollStepEl?.value) || defaults.scrollStep,
    scrollDelay: Number(scrollDelayEl?.value) || defaults.scrollDelay,
    inactivityTimeout: Number(inactivityTimeoutEl?.value) || defaults.inactivityTimeout,
    maxSteps: Number(maxStepsEl?.value) || defaults.maxSteps,
    retryAttempts: Number(retryAttemptsEl?.value) || defaults.retryAttempts,
    retryDelay: Number(retryDelayEl?.value) || defaults.retryDelay
  };
}

// === Storage ===
function persistSettings(settings) {
  const settingsJson = JSON.stringify(settings, null, 2);
  chrome.storage.local.set({ settings, settingsJson }, () => {
    const defaults = window.DEFAULT_SETTINGS || {};
    state.settings = { ...defaults, ...settings };
    renderSettings();
    
    // Резервное копирование в sync storage
    chrome.runtime.sendMessage({ type: 'BACKUP_SETTINGS', settings }).catch(() => {});
  });
}

function loadState() {
  chrome.storage.local.get(
    ['links', 'numbers', 'duplicates', 'duplicateMap', 'duplicateUniqueCount', 'logs', 'settings', 'settingsJson', 'chatTitle'],
    (res) => {
      const defaults = window.DEFAULT_SETTINGS || {};
      state.links = res.links || [];
      state.numbers = res.numbers || [];
      state.duplicateMap = res.duplicateMap || {};
      state.duplicateUniqueCount = res.duplicateUniqueCount || Object.keys(state.duplicateMap).length;
      state.duplicates = res.duplicates || [];
      state.logs = res.logs || [];
      state.chatTitle = res.chatTitle || '';
      
      const fromJson = res.settingsJson ? safeParseJson(res.settingsJson) : null;
      state.settings = {
        ...defaults,
        ...(res.settings || {}),
        ...(fromJson || {})
      };

      updateStats();
      updateStatus();
      renderList(linksListEl, state.links);
      renderList(numbersListEl, state.numbers);
      renderList(duplicatesListEl, getDuplicateDisplayList(state.duplicateMap, state.duplicates), { limit: 200 });
      renderList(logsListEl, state.logs, { limit: 100, isLog: true });
      renderSettings();
    }
  );
}

// === Коммуникация с content script ===
function sendToActiveTab(message, callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) {
      callback?.({ error: 'No active tab' });
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
      if (chrome.runtime.lastError) {
        // Попробуем инжектировать content script
        chrome.scripting?.executeScript({
          target: { tabId: tabs[0].id },
          files: ['shared.js', 'content.js']
        }).then(() => {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabs[0].id, message, callback);
          }, 50); // Небольшая задержка для загрузки скриптов
        }).catch(injectError => {
          console.error('Ошибка внедрения скрипта:', injectError);
          callback?.({ error: `Cannot inject content script: ${injectError.message}` });
        });
      } else {
        callback?.(response);
      }
    });
  });
}

// Получаем статус сбора
function refreshStatus() {
  sendToActiveTab({ type: 'GET_STATUS' }, (response) => {
    if (response && !response.error) {
      state.isRunning = response.isRunning || false;
      state.isPaused = response.isPaused || false;
      updateStatus();
    }
  });
}

// === Экспорт файлов ===
function downloadFile(content, filename, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// === Импорт настроек ===
function importSettingsFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const settings = JSON.parse(event.target.result);
        persistSettings(settings);
        showToast('Настройки импортированы!', 'success');
      } catch (err) {
        showToast('Ошибка импорта: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// === Toast уведомления ===
function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// === Event Listeners ===

// Старт
startBtn?.addEventListener('click', () => {
  state.isRunning = true;
  state.isPaused = false;
  updateStatus();
  sendToActiveTab({ type: 'START_COLLECTION' });
});

// Стоп
stopBtn?.addEventListener('click', () => {
  state.isRunning = false;
  state.isPaused = false;
  updateStatus();
  sendToActiveTab({ type: 'STOP_COLLECTION' });
});

// Пауза/Продолжить
pauseBtn?.addEventListener('click', () => {
  if (state.isPaused) {
    state.isPaused = false;
    sendToActiveTab({ type: 'RESUME_COLLECTION' });
  } else {
    state.isPaused = true;
    sendToActiveTab({ type: 'PAUSE_COLLECTION' });
  }
  updateStatus();
});

// Экспорт ссылок
$('exportBtn')?.addEventListener('click', () => {
  downloadFile(state.links.join('\n'), buildExportName('links'));
});

// Экспорт дублей
$('exportDupBtn')?.addEventListener('click', () => {
  downloadFile(buildDuplicateExport(state.duplicateMap, state.duplicates), buildExportName('duplicates'));
});

// Экспорт номеров
$('exportNumbersBtn')?.addEventListener('click', () => {
  downloadFile(state.numbers.join('\n'), buildExportName('numbers'));
});

// Экспорт логов
$('exportLogsBtn')?.addEventListener('click', () => {
  downloadFile(state.logs.join('\n'), buildExportName('logs'));
});

// Очистка
$('clearBtn')?.addEventListener('click', () => {
  if (!confirm('Удалить все собранные данные?')) return;
  
  chrome.storage.local.remove(['links', 'numbers', 'duplicates', 'duplicateMap', 'duplicateUniqueCount', 'logs', 'chatTitle'], () => {
    state.links = [];
    state.numbers = [];
    state.duplicates = [];
    state.duplicateMap = {};
    state.duplicateUniqueCount = 0;
    state.logs = [];
    state.chatTitle = '';
    updateStats();
    renderList(linksListEl, state.links);
    renderList(numbersListEl, state.numbers);
    renderList(duplicatesListEl, []);
    renderList(logsListEl, state.logs);
    showToast('Данные очищены', 'success');
  });
});

// Сохранение настроек
$('saveSettingsBtn')?.addEventListener('click', () => {
  const settings = readSettingsFromUi();
  persistSettings(settings);
  showToast('Настройки сохранены', 'success');
});

// Экспорт настроек
$('exportSettingsBtn')?.addEventListener('click', () => {
  const settings = readSettingsFromUi();
  downloadFile(JSON.stringify(settings, null, 2), 'settings.json', 'application/json');
});

// Импорт настроек
$('importSettingsBtn')?.addEventListener('click', () => {
  importSettingsFromFile();
});

// Восстановление из облака
$('restoreFromCloudBtn')?.addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESTORE_SETTINGS' });
    if (response?.success && response.settings) {
      persistSettings(response.settings);
      showToast('Настройки восстановлены из облака', 'success');
    } else {
      showToast('Резервная копия не найдена', 'warn');
    }
  } catch (e) {
    showToast('Ошибка восстановления', 'error');
  }
});

// Сброс к дефолтам
$('resetSettingsBtn')?.addEventListener('click', () => {
  if (!confirm('Сбросить настройки к значениям по умолчанию?')) return;
  persistSettings(window.DEFAULT_SETTINGS || {});
  showToast('Настройки сброшены', 'success');
});

// === Picker селекторов ===
$('pickScrollSelectorBtn')?.addEventListener('click', () => {
  sendToActiveTab({ type: 'START_SELECTOR_PICKER', callbackType: 'scroll' });
  showToast('Кликните на контейнер скролла на странице', 'info');
});

$('pickLinkSelectorBtn')?.addEventListener('click', () => {
  sendToActiveTab({ type: 'START_SELECTOR_PICKER', callbackType: 'link' });
  showToast('Кликните на элемент ссылки на странице', 'info');
});

// === Проверка селекторов ===
$('testSelectorsBtn')?.addEventListener('click', () => {
  const settings = readSettingsFromUi();
  const testResultEl = $('testResult');
  
  if (testResultEl) {
    testResultEl.style.display = 'block';
    testResultEl.innerHTML = '<span class="testing">Проверка...</span>';
    testResultEl.className = 'test-result';
  }
  showToast('Проверка селекторов...', 'info');
  
  sendToActiveTab({ 
    type: 'CHECK_SELECTORS',
    scrollSelector: settings.scrollSelector,
    linkSelectors: settings.linkSelectors
  });
});

// Функция обработки результатов проверки селекторов
function handleSelectorTestResult(response) {
  const testResultEl = $('testResult');
  
  if (!response) {
    if (testResultEl) {
      testResultEl.innerHTML = '<span class="error">Нет ответа от страницы</span>';
      testResultEl.className = 'test-result error';
    }
    showToast('Нет ответа от страницы', 'error');
    return;
  }
    
  if (response.error) {
    if (testResultEl) {
      testResultEl.innerHTML = `<span class="error">Ошибка: ${response.error}</span>`;
      testResultEl.className = 'test-result error';
    }
    showToast(response.error, 'error');
    return;
  }
  
  const { scrollResult, linkCounts } = response;
  let html = '';
  let hasDirectMatch = false;
  let hasGeneralizedMatch = false;
  
  // Результат скролла (уже форматированная строка)
  if (scrollResult) {
    html += scrollResult + '<br>';
    if (scrollResult.includes('(прямой') || scrollResult.includes('Найден (прямой)')) {
      hasDirectMatch = true;
    }
    if (scrollResult.includes('обобщ')) {
      hasGeneralizedMatch = true;
    }
  }
  
  // Результаты ссылок
  if (linkCounts && Object.keys(linkCounts).length > 0) {
    let totalDirect = 0;
    let totalGeneralized = 0;
    
    Object.entries(linkCounts).forEach(([selector, countStr]) => {
      // countStr может быть строкой вида "5 (обобщ: 3)" или числом
      let directCount = 0;
      let genCount = 0;
      
      if (typeof countStr === 'string' && countStr.includes('(обобщ:')) {
        const match = countStr.match(/^(\d+).*\(обобщ:\s*(\d+)\)/);
        if (match) {
          directCount = parseInt(match[1]) || 0;
          genCount = parseInt(match[2]) || 0;
        }
      } else {
        directCount = parseInt(countStr) || 0;
      }
      
      totalDirect += directCount;
      totalGeneralized += genCount;
      
      if (directCount > 0) {
        html += `<span class="success">✓</span> "${selector}": ${directCount}`;
        if (genCount > 0 && genCount !== directCount) {
          html += ` <span class="info">(обобщ: ${genCount})</span>`;
        }
        html += '<br>';
      } else if (genCount > 0) {
        html += `<span class="success">✓</span> "${selector}": ${genCount} (обобщ.)<br>`;
      } else {
        html += `<span class="error">✗</span> "${selector}": 0 элементов<br>`;
      }
    });
    
    html += `<strong>Всего: ${totalDirect} (прямой) + ${totalGeneralized} (обобщ.)</strong>`;
    
    if (totalDirect > 0) hasDirectMatch = true;
    if (totalGeneralized > 0) hasGeneralizedMatch = true;
  } else {
    html += '<span class="error">Ни один селектор ссылок не нашёл элементов</span>';
  }
  
  if (testResultEl) {
    testResultEl.innerHTML = html;
    testResultEl.className = hasDirectMatch || hasGeneralizedMatch 
      ? 'test-result success' 
      : 'test-result error';
  }
  
  const isSuccess = hasDirectMatch || hasGeneralizedMatch;
  showToast(isSuccess ? 'Селекторы работают корректно' : 'Есть проблемы с селекторами', isSuccess ? 'success' : 'warn');
}

// === Табы ===
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.tab)?.classList.add('active');
  });
});

// === Автосохранение настроек ===
let autoSaveTimeout = null;
function scheduleAutoSave() {
  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(() => {
    const settings = readSettingsFromUi();
    persistSettings(settings);
  }, 1500);
}

[scrollSelectorEl, linkSelectorsEl, scrollStepEl, scrollDelayEl, inactivityTimeoutEl, maxStepsEl, retryAttemptsEl, retryDelayEl].forEach((el) => {
  el?.addEventListener('input', scheduleAutoSave);
  el?.addEventListener('change', scheduleAutoSave);
});

// === Слушаем сообщения ===
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED') {
    // Throttle - игнорируем слишком частые обновления
    const now = Date.now();
    if (now - lastStateUpdate < STATE_UPDATE_THROTTLE_MS) {
      return;
    }
    lastStateUpdate = now;
    
    // Загружаем только данные, не обновляем статус кнопок
    chrome.storage.local.get(
      ['links', 'numbers', 'duplicates', 'duplicateMap', 'duplicateUniqueCount', 'logs', 'settings', 'settingsJson', 'chatTitle'],
      (res) => {
        const defaults = window.DEFAULT_SETTINGS || {};
        state.links = res.links || [];
        state.numbers = res.numbers || [];
        state.duplicateMap = res.duplicateMap || {};
        state.duplicateUniqueCount = res.duplicateUniqueCount || Object.keys(state.duplicateMap).length;
        state.duplicates = res.duplicates || [];
        state.logs = res.logs || [];
        state.chatTitle = res.chatTitle || '';

        const fromJson = res.settingsJson ? safeParseJson(res.settingsJson) : null;
        state.settings = {
          ...defaults,
          ...(res.settings || {}),
          ...(fromJson || {})
        };

        updateStats();
        // НЕ вызываем updateStatus() здесь, чтобы кнопки не менялись автоматически
        renderList(linksListEl, state.links);
        renderList(numbersListEl, state.numbers);
        renderList(duplicatesListEl, getDuplicateDisplayList(state.duplicateMap, state.duplicates), { limit: 200 });
        renderList(logsListEl, state.logs, { limit: 100, isLog: true });
        renderSettings();
      }
    );
  }
  if (message?.type === 'SELECTOR_PICKED') {
    try {
      if (message.callbackType === 'scroll' && scrollSelectorEl) {
        scrollSelectorEl.value = message.selector;
        showToast('Селектор скролла выбран', 'success');
        // Моментальное сохранение
        const settings = readSettingsFromUi();
        persistSettings(settings);
      } else if (message.callbackType === 'link' && linkSelectorsEl) {
        // Заменяем старый селектор на новый
        linkSelectorsEl.value = message.selector;
        showToast('Селектор ссылки заменён', 'success');
        // Моментальное сохранение
        const settings = readSettingsFromUi();
        persistSettings(settings);
      }
    } catch (error) {
      console.error('Ошибка обработки полученного селектора:', error);
      showToast(`Ошибка обработки селектора: ${error.message}`, 'error');
    }
  }
  if (message?.type === 'SELECTORS_TESTED') {
    handleSelectorTestResult(message);
  }
});

// === Инициализация ===
loadState();
refreshStatus();
sendToActiveTab({ type: 'SYNC_CHAT_TITLE' });

// Периодическое обновление статуса - раз в 5 секунд вместо 2
setInterval(refreshStatus, 5000);


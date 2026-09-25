(() => {
  'use strict';

  const STORAGE_KEY = 'moneyflow-v3';
  const SYNC_STATE_KEY = 'moneyflow-sync-state';
  let syncInFlight = false;

  const readJson = (key, fallback = {}) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  };

  const writeJson = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Ignore write failures in private/incognito modes.
    }
  };

  const readState = () => readJson(STORAGE_KEY, {});
  const saveState = (state) => writeJson(STORAGE_KEY, state);

  const getSyncUrl = () => {
    const state = readState();
    return String(state?.settings?.syncUrl || '').trim();
  };

  const setSyncUrl = (url) => {
    const cleaned = String(url || '').trim();
    const state = readState();
    state.settings = state.settings || {};
    state.settings.syncUrl = cleaned;
    saveState(state);
    const input = document.getElementById('syncUrl');
    if (input) input.value = cleaned;
  };

  const setStatus = (message, tone = 'idle') => {
    const node = document.getElementById('syncStatus');
    if (!node) return;

    node.textContent = message;
    node.dataset.status = tone;
  };

  const showToast = (message, tone = 'success') => {
    const node = document.getElementById('toast');
    if (!node) return;

    node.textContent = message;
    node.dataset.tone = tone;
    node.classList.add('on');

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      node.classList.remove('on');
    }, 2600);
  };

  const ensureSyncUrlInput = () => {
    const existing = document.getElementById('syncUrl');
    if (existing) return existing;

    const settingsList = document.querySelector('#settings .settings-list');
    if (!settingsList) return null;

    const row = document.createElement('label');
    row.className = 'sync-url-row';
    row.innerHTML = `
      <span>Google Apps Script URL</span>
      <input
        id="syncUrl"
        type="url"
        inputmode="url"
        placeholder="https://script.google.com/macros/s/AK.../exec"
        autocomplete="url"
      />
    `;

    settingsList.appendChild(row);
    return row.querySelector('input');
  };

  const wireSyncUrlInput = () => {
    const input = ensureSyncUrlInput();
    if (!input || input.dataset.bound === 'true') return;

    input.dataset.bound = 'true';
    input.value = getSyncUrl();

    input.addEventListener('input', (event) => {
      const value = String(event.target.value || '').trim();
      const state = readState();
      state.settings = state.settings || {};
      state.settings.syncUrl = value;
      saveState(state);

      setStatus(value ? 'Ready to sync' : 'Sync URL required', value ? 'idle' : 'warning');
    });
  };

  const askForSyncUrl = () => {
    const current = getSyncUrl();
    const entered = window.prompt('Enter your Google Apps Script /exec URL', current);
    if (!entered || !entered.trim()) return '';

    const value = entered.trim();
    setSyncUrl(value);
    return value;
  };

  const requestJson = async (url, options = {}) => {
    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        let errorText = '';
        try {
          const body = await response.json();
          errorText = body?.error || body?.message || '';
        } catch (_) {}
        throw new Error(errorText || `Request failed (${response.status})`);
      }

      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (_) {
        return { ok: true, raw: text };
      }
    } catch (error) {
      throw new Error(error.message || 'Network request failed');
    }
  };

  const applyRemoteData = (remote) => {
    if (!remote || typeof remote !== 'object') {
      throw new Error('The sheet returned no data');
    }

    const state = readState();
    const incoming = remote.data || remote;

    state.transactions = Array.isArray(incoming.transactions) ? incoming.transactions : [];
    state.categories = Array.isArray(incoming.categories) && incoming.categories.length
      ? incoming.categories
      : (state.categories || []);
    state.budgets = Array.isArray(incoming.budgets) ? incoming.budgets : [];
    state.loans = Array.isArray(incoming.loans) ? incoming.loans : [];

    saveState(state);
    window.dispatchEvent(new CustomEvent('moneyflow:state-updated'));
    return state;
  };

  const pullFromSheets = async (url, reason = 'manual') => {
    if (!url) return false;

    setStatus('Loading from Google Sheets…', 'loading');

    try {
      const result = await requestJson(`${url}${url.includes('?') ? '&' : '?'}action=getAll`);
      if (!result || result.ok === false) {
        throw new Error(result?.error || 'Google Sheets did not return valid data.');
      }

      applyRemoteData(result.data || result);
      setStatus('Loaded from Google Sheets', 'success');

      if (reason === 'manual') {
        showToast('Loaded data from Google Sheets.');
      }

      return true;
    } catch (error) {
      setStatus('Sync failed', 'error');
      showToast(error.message || 'Could not load data from Google Sheets.', 'error');
      return false;
    }
  };

  const pushToSheets = async (url, state) => {
    if (!url) return false;

    const payload = {
      action: 'appendDelta',
      transactions: Array.isArray(state.transactions) ? state.transactions : [],
      budgets: Array.isArray(state.budgets) ? state.budgets : [],
      categories: Array.isArray(state.categories) ? state.categories : [],
      loans: Array.isArray(state.loans) ? state.loans : [],
      syncedAt: new Date().toISOString()
    };

    const result = await requestJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (result && result.ok === false) {
      throw new Error(result.error || 'Google Sheets sync rejected the payload.');
    }

    return result;
  };

  const syncToGoogleSheets = async (reason = 'manual') => {
    if (syncInFlight) return false;
    const url = getSyncUrl() || askForSyncUrl();

    if (!url) {
      setStatus('Sync URL required', 'warning');
      showToast('Add your Google Apps Script URL in Settings.', 'error');
      return false;
    }

    syncInFlight = true;

    try {
      setStatus('Syncing…', 'loading');

      await pushToSheets(url, readState());
      await pullFromSheets(url, 'silent');

      setStatus('Synced and loaded just now', 'success');
      if (reason === 'manual') {
        showToast('Google Sheets sync completed.');
      }
      return true;
    } catch (error) {
      setStatus('Sync failed', 'error');
      showToast(error.message || 'Sync failed. Check the Apps Script URL and deployment.', 'error');
      return false;
    } finally {
      syncInFlight = false;
    }
  };

  const maybeBindSyncButton = () => {
    const button = document.getElementById('syncButton');
    if (button && !button.dataset.boundSync) {
      button.dataset.boundSync = 'true';
      button.addEventListener('click', () => syncToGoogleSheets('manual'));
    }
  };

  const maybeBindSaveTriggers = () => {
    const formIds = ['transactionForm', 'budgetForm', 'categoryForm', 'loanForm'];
    formIds.forEach((id) => {
      const form = document.getElementById(id);
      if (!form || form.dataset.boundSyncTriggers) return;

      form.dataset.boundSyncTriggers = 'true';
      form.addEventListener('submit', () => {
        const url = getSyncUrl();
        if (url) {
          setTimeout(() => syncToGoogleSheets('save'), 250);
        }
      });
    });
  };

  const init = () => {
    wireSyncUrlInput();

    const url = getSyncUrl();
    setStatus(url ? 'Ready to sync' : 'Sync URL required', url ? 'idle' : 'warning');

    maybeBindSyncButton();
    maybeBindSaveTriggers();

    window.syncToGoogleSheets = syncToGoogleSheets;
    window.pullFromGoogleSheets = () => {
      const url = getSyncUrl() || askForSyncUrl();
      return url ? pullFromSheets(url, 'manual') : false;
    };

    window.addEventListener('moneyflow:state-updated', () => {
      const url = getSyncUrl();
      if (url) {
        setStatus('Data refreshed', 'success');
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

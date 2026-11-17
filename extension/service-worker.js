importScripts('shared.js');

const isTextInputKind = kind => String(kind).startsWith('text_gdiplus') || String(kind).startsWith('text_ft2_source');
const runtimeState = {
  socket: null,
  status: '未接続',
  error: '',
  sources: [],
  scenes: [],
  inputKinds: [],
  password: '',
  pending: new Map(),
  keepAliveTimer: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  manualDisconnect: false,
  lastYoutubeHeartbeat: 0
};

const getSettings = () => chrome.storage.local.get(CounterUtils.defaults);

const setStatus = (status, error = '') => {
  runtimeState.status = status;
  runtimeState.error = error;
  chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
};

const clearPending = error => {
  runtimeState.pending.forEach(item => {
    clearTimeout(item.timeout);
    item.reject(error);
  });
  runtimeState.pending.clear();
};

const stopKeepAlive = () => {
  clearInterval(runtimeState.keepAliveTimer);
  runtimeState.keepAliveTimer = null;
};

const startKeepAlive = () => {
  stopKeepAlive();
  runtimeState.keepAliveTimer = setInterval(() => {
    request('GetVersion').catch(() => runtimeState.socket?.close());
  }, 20000);
};

const request = (requestType, requestData = {}, timeoutMs = 8000) => new Promise((resolve, reject) => {
  if (runtimeState.socket?.readyState !== WebSocket.OPEN || runtimeState.status !== '接続済み') {
    reject(new Error('OBSに接続されていません。'));
    return;
  }
  const requestId = crypto.randomUUID();
  const timeout = setTimeout(() => {
    runtimeState.pending.delete(requestId);
    reject(new Error(`${requestType}がタイムアウトしました。`));
  }, timeoutMs);
  runtimeState.pending.set(requestId, { resolve, reject, timeout });
  runtimeState.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
});

const refreshObsLists = async () => {
  const [inputsResponse, scenesResponse, kindsResponse] = await Promise.all([
    request('GetInputList'),
    request('GetSceneList'),
    request('GetInputKindList', { unversioned: false })
  ]);
  runtimeState.sources = (inputsResponse.inputs || []).filter(input => isTextInputKind(input.inputKind));
  runtimeState.scenes = scenesResponse.scenes || [];
  runtimeState.inputKinds = kindsResponse.inputKinds || [];
  chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
};

const scheduleReconnect = async () => {
  const settings = await getSettings();
  if (runtimeState.manualDisconnect || !settings.autoConnect) return;
  clearTimeout(runtimeState.reconnectTimer);
  const delay = Math.min(30000, 2000 * (2 ** runtimeState.reconnectAttempt));
  runtimeState.reconnectAttempt += 1;
  runtimeState.reconnectTimer = setTimeout(() => connectObs().catch(() => {}), delay);
};

const handleSocketMessage = async (event, socket) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.op === 0) {
    const identify = { rpcVersion: 1 };
    if (message.d.authentication) {
      if (!runtimeState.password) {
        setStatus('認証エラー', 'OBS WebSocketのパスワードを入力してください。');
        socket.close();
        return;
      }
      identify.authentication = await CounterUtils.createObsAuthentication(
        runtimeState.password,
        message.d.authentication.salt,
        message.d.authentication.challenge
      );
    }
    socket.send(JSON.stringify({ op: 1, d: identify }));
    return;
  }
  if (message.op === 2) {
    runtimeState.reconnectAttempt = 0;
    setStatus('接続済み');
    startKeepAlive();
    await refreshObsLists();
    await updateObsText(true).catch(() => {});
    return true;
  }
  if (message.op === 7) {
    const pending = runtimeState.pending.get(message.d.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    runtimeState.pending.delete(message.d.requestId);
    if (message.d.requestStatus?.result) pending.resolve(message.d.responseData || {});
    else pending.reject(new Error(message.d.requestStatus?.comment || `${message.d.requestType}に失敗しました。`));
  }
};

const connectObs = async config => {
  const settings = await getSettings();
  const host = config?.host ?? settings.host;
  const port = config?.port ?? settings.port;
  const savePassword = Boolean(config?.savePassword ?? settings.savePassword);
  const suppliedPassword = config?.password ?? '';
  runtimeState.password = suppliedPassword || (savePassword ? settings.password : runtimeState.password);
  runtimeState.manualDisconnect = false;
  clearTimeout(runtimeState.reconnectTimer);
  if (runtimeState.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(runtimeState.socket.readyState)) {
    runtimeState.socket.close();
  }
  const url = CounterUtils.buildObsUrl(host, port);
  await chrome.storage.local.set({
    host,
    port: CounterUtils.validatePort(port),
    autoConnect: config?.autoConnect ?? settings.autoConnect,
    savePassword,
    password: savePassword ? runtimeState.password : ''
  });
  setStatus('接続中');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, 'obswebsocket.json');
    runtimeState.socket = socket;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimeout);
      callback(value);
    };
    const connectionTimeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) socket.close();
      finish(reject, new Error('OBSへの接続または認証がタイムアウトしました。'));
    }, 8000);
    socket.addEventListener('message', event => {
      if (runtimeState.socket !== socket) return;
      handleSocketMessage(event, socket)
        .then(identified => {
          if (identified) finish(resolve, { ok: true });
        })
        .catch(error => {
          setStatus('接続エラー', error.message);
          finish(reject, error);
        });
    });
    socket.addEventListener('error', () => {
      if (runtimeState.socket !== socket) return;
      setStatus('接続エラー', 'OBSが起動しているか、接続先とポートを確認してください。');
    });
    socket.addEventListener('close', event => {
      if (runtimeState.socket !== socket) return;
      finish(reject, new Error(event.code === 4009 ? 'パスワードが正しくありません。' : 'OBSとの接続が切れました。'));
      stopKeepAlive();
      clearPending(new Error('OBSとの接続が切れました。'));
      runtimeState.socket = null;
      if (!runtimeState.manualDisconnect) {
        const reason = event.code === 4009 ? 'パスワードが正しくありません。' : 'OBSとの接続が切れました。再接続します。';
        setStatus('切断', reason);
        scheduleReconnect();
      } else {
        setStatus('未接続');
      }
    });
  });
};

const disconnectObs = () => {
  runtimeState.manualDisconnect = true;
  clearTimeout(runtimeState.reconnectTimer);
  stopKeepAlive();
  runtimeState.socket?.close(1000, 'User disconnected');
  runtimeState.socket = null;
  setStatus('未接続');
};

const updateObsText = async force => {
  const settings = await getSettings();
  if (!settings.inputName || runtimeState.status !== '接続済み') return { skipped: true };
  let target = settings.target;
  if (settings.autoTarget) {
    target = CounterUtils.nextAutomaticTarget(settings.current, target);
    if (target !== settings.target) await chrome.storage.local.set({ target });
  }
  const text = CounterUtils.formatCounter(settings.current, target, settings.separator, settings.template);
  if (!text) throw new Error('現在数または目標数が正しくありません。');
  if (!force && text === settings.lastSentText) return { skipped: true, text };
  await request('SetInputSettings', {
    inputName: settings.inputName,
    inputSettings: { text },
    overlay: true
  });
  runtimeState.error = '';
  await chrome.storage.local.set({ lastSentText: text, target });
  return { text };
};

const createTextSource = async ({ sceneName, inputName }) => {
  const cleanName = String(inputName || '').trim().slice(0, 80);
  if (!cleanName || !sceneName) throw new Error('シーンとソース名を入力してください。');
  const inputKind = runtimeState.inputKinds.find(kind => String(kind).startsWith('text_gdiplus'))
    || runtimeState.inputKinds.find(kind => String(kind).startsWith('text_ft2_source'));
  if (!inputKind) throw new Error('このOBS環境で利用できるテキストソースが見つかりません。');
  const settings = await getSettings();
  const text = CounterUtils.formatCounter(settings.current ?? 0, settings.target, settings.separator, settings.template);
  await request('CreateInput', {
    sceneName,
    inputName: cleanName,
    inputKind,
    inputSettings: { text },
    sceneItemEnabled: true
  });
  await chrome.storage.local.set({ inputName: cleanName, lastSentText: text });
  await refreshObsLists();
  return { inputName: cleanName };
};

const publicState = async () => {
  const settings = await getSettings();
  const youtubeActive = settings.selectedTabId && Date.now() - runtimeState.lastYoutubeHeartbeat < 45000;
  return {
    settings: { ...settings, password: settings.savePassword ? settings.password : '' },
    obs: {
      status: runtimeState.status,
      error: runtimeState.error,
      sources: runtimeState.sources,
      scenes: runtimeState.scenes
    },
    youtubeActive: Boolean(youtubeActive),
    preview: CounterUtils.formatCounter(settings.current, settings.target, settings.separator, settings.template)
  };
};

const saveSettings = async values => {
  const currentSettings = await getSettings();
  const target = CounterUtils.parsePositiveInteger(values.target);
  if (!target) throw new Error('目標登録者数は1以上の整数にしてください。');
  const next = {
    target,
    separator: String(values.separator ?? currentSettings.separator).slice(0, 12),
    template: String(values.template ?? currentSettings.template).slice(0, 120),
    autoTarget: Boolean(values.autoTarget),
    autoConnect: Boolean(values.autoConnect),
    inputName: String(values.inputName ?? currentSettings.inputName).slice(0, 120)
  };
  if (!next.template.includes('{current}') || !next.template.includes('{target}')) {
    throw new Error('表示形式には{current}と{target}が必要です。');
  }
  await chrome.storage.local.set(next);
  await updateObsText(false).catch(error => {
    if (runtimeState.status === '接続済み') throw error;
  });
  return publicState();
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message.type === 'getState') return publicState();
    if (message.type === 'connectObs') {
      await connectObs(message.config);
      return publicState();
    }
    if (message.type === 'disconnectObs') {
      disconnectObs();
      return publicState();
    }
    if (message.type === 'refreshObsLists') {
      await refreshObsLists();
      return publicState();
    }
    if (message.type === 'createTextSource') {
      await createTextSource(message);
      return publicState();
    }
    if (message.type === 'saveSettings') return saveSettings(message.values);
    if (message.type === 'manualUpdate') {
      const value = CounterUtils.parseSubscriberCount(message.value);
      if (value === null) throw new Error('現在の登録者数は0以上の整数にしてください。');
      await chrome.storage.local.set({ current: value, lastCapturedAt: new Date().toISOString(), youtubeStatus: '手動更新' });
      await updateObsText(false);
      return publicState();
    }
    if (message.type === 'quickUpdate') {
      if (runtimeState.status !== '接続済み') throw new Error('先にOBSへ接続してください。');
      const value = CounterUtils.parseSubscriberCount(message.value);
      const target = CounterUtils.parsePositiveInteger(message.target);
      const inputName = String(message.inputName || '').trim();
      const template = String(message.template || '').slice(0, 120);
      if (value === null) throw new Error('現在の登録者数は0以上の整数にしてください。');
      if (!target) throw new Error('目標登録者数は1以上の整数にしてください。');
      if (!inputName) throw new Error('更新対象のテキストソースを選択してください。');
      if (!template.includes('{current}') || !template.includes('{target}')) {
        throw new Error('表示形式には{current}と{target}が必要です。');
      }
      await chrome.storage.local.set({
        current: value,
        target,
        inputName,
        separator: String(message.separator || '').slice(0, 12),
        template,
        lastCapturedAt: new Date().toISOString(),
        youtubeStatus: '手動更新'
      });
      await updateObsText(true);
      return publicState();
    }
    if (message.type === 'forceUpdate') {
      await updateObsText(true);
      return publicState();
    }
    if (message.type === 'subscriberUpdate') {
      const value = CounterUtils.parseSubscriberCount(message.value);
      if (value === null) return { ignored: true };
      runtimeState.lastYoutubeHeartbeat = Date.now();
      await chrome.storage.local.set({
        current: value,
        selectedSelector: message.selector || undefined,
        youtubeStatus: '自動取得中',
        lastCapturedAt: new Date().toISOString(),
        selectedTabId: sender.tab?.id ?? null
      });
      await updateObsText(false).catch(error => {
        runtimeState.error = `OBS更新失敗: ${error.message}`;
      });
      chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'selectionSaved') {
      runtimeState.lastYoutubeHeartbeat = Date.now();
      await chrome.storage.local.set({
        selectedSelector: message.selector,
        selectedTabId: sender.tab?.id ?? null,
        youtubeStatus: '自動取得中',
        current: message.value,
        lastCapturedAt: new Date().toISOString()
      });
      await updateObsText(true).catch(error => {
        runtimeState.error = `OBS更新失敗: ${error.message}`;
      });
      chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'youtubeStatus') {
      runtimeState.lastYoutubeHeartbeat = Date.now();
      await chrome.storage.local.set({ youtubeStatus: message.status, selectedTabId: sender.tab?.id ?? null });
      return { ok: true };
    }
    if (message.type === 'resetSettings') {
      disconnectObs();
      await chrome.storage.local.clear();
      return publicState();
    }
    throw new Error('未対応の操作です。');
  };
  run().then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const settings = await getSettings();
  if (settings.selectedTabId === tabId) {
    runtimeState.lastYoutubeHeartbeat = 0;
    await chrome.storage.local.set({ selectedTabId: null, youtubeStatus: 'YouTube Studioが閉じられたため停止' });
    chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'obs-health') return;
  if (runtimeState.status === '接続済み') {
    request('GetVersion').catch(() => runtimeState.socket?.close());
  } else {
    const settings = await getSettings();
    if (settings.autoConnect && !runtimeState.manualDisconnect) connectObs().catch(() => {});
  }
});

const initialize = async () => {
  await chrome.alarms.create('obs-health', { periodInMinutes: 1 });
  const settings = await getSettings();
  if (settings.autoConnect) connectObs().catch(() => {});
};

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'update' && ['2.0.0', '2.0.1', '2.0.2', '2.0.3', '2.1.0', '2.1.1', '2.1.2', '2.1.3', '2.1.4', '2.1.5', '2.1.6'].includes(details.previousVersion)) {
    await chrome.storage.local.set({
      selectedSelector: '',
      selectedTabId: null,
      youtubeStatus: '更新後に登録者数を再選択してください'
    });
  }
  await initialize();
});
chrome.runtime.onStartup.addListener(initialize);
initialize();

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
let formDirty = false;

const send = message => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return;
    }
    if (!response?.ok) {
      reject(new Error(response?.error || '処理に失敗しました。'));
      return;
    }
    resolve(response.result);
  });
});

const showMessage = (message, isError = false) => {
  elements['global-message'].textContent = message;
  elements['global-message'].style.color = isError ? '#a73535' : '';
};

const option = (value, label) => {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
};

const formatDate = value => {
  if (!value) return '未取得';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未取得' : date.toLocaleString('ja-JP');
};

const renderState = state => {
  const { settings, obs, youtubeActive, preview } = state;
  elements['current-value'].textContent = settings.current ?? '未取得';
  elements['manual-current'].value = settings.current ?? '';
  elements['captured-at'].textContent = formatDate(settings.lastCapturedAt);
  elements['youtube-status'].textContent = youtubeActive ? settings.youtubeStatus : settings.selectedSelector ? '停止中・Studioを開いてください' : settings.youtubeStatus;
  elements['obs-status'].textContent = obs.status;
  elements['host'].value = settings.host;
  elements['port'].value = settings.port;
  elements['password'].value = settings.savePassword ? settings.password : '';
  elements['save-password'].checked = settings.savePassword;
  elements['target'].value = settings.target;
  elements['separator'].value = settings.separator;
  elements['template'].value = settings.template;
  elements['auto-target'].checked = settings.autoTarget;
  elements['auto-connect'].checked = settings.autoConnect;
  elements['preview'].textContent = preview || '--- / 1,000';

  elements['input-name'].replaceChildren(option('', obs.status === '接続済み' ? 'テキストソースを選択' : '接続後に選択'));
  obs.sources.forEach(source => elements['input-name'].append(option(source.inputName, `${source.inputName}（${source.inputKind}）`)));
  elements['input-name'].value = settings.inputName;

  elements['scene-name'].replaceChildren(option('', obs.status === '接続済み' ? 'シーンを選択' : '接続後に選択'));
  obs.scenes.forEach(scene => elements['scene-name'].append(option(scene.sceneName, scene.sceneName)));

  const connected = obs.status === '接続済み';
  elements['quick-help'].textContent = !connected
    ? '最初にOBSへ接続してください。'
    : settings.inputName
      ? '入力した数字をすぐにOBSへ反映できます。'
      : '更新対象のテキストソースを選択してください。';
  elements.connect.disabled = connected;
  elements.disconnect.disabled = !connected;
  elements['refresh-sources'].disabled = !connected;
  elements['force-update'].disabled = !connected;
  elements['create-source'].disabled = !connected;
  if (obs.error) showMessage(obs.error, true);
};

const loadState = async () => renderState(await send({ type: 'getState' }));

const withAction = async action => {
  try {
    showMessage('処理中です。');
    const result = await action();
    if (result?.settings) renderState(result);
    showMessage('完了しました。');
  } catch (error) {
    showMessage(error.message, true);
  }
};

const startSelection = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://studio.youtube.com/')) throw new Error('YouTube Studioの画面を開いてから実行してください。');
  await chrome.tabs.sendMessage(tab.id, { type: 'startSelection' });
  showMessage('Studio画面で登録者数の数字だけをドラッグ選択してください。');
  window.close();
};

elements['select-number'].addEventListener('click', () => withAction(startSelection));
elements['reselect-number'].addEventListener('click', () => withAction(startSelection));

elements['manual-update'].addEventListener('click', () => withAction(() => send({
  type: 'quickUpdate',
  value: elements['manual-current'].value,
  inputName: elements['input-name'].value,
  target: elements.target.value,
  separator: elements.separator.value,
  template: elements.template.value
})));

elements['input-name'].addEventListener('change', () => {
  elements['quick-help'].textContent = elements['input-name'].value
    ? '入力した数字をすぐにOBSへ反映できます。'
    : '更新対象のテキストソースを選択してください。';
});

elements.connect.addEventListener('click', () => withAction(() => send({
  type: 'connectObs',
  config: {
    host: elements.host.value.trim(),
    port: elements.port.value,
    password: elements.password.value,
    savePassword: elements['save-password'].checked,
    autoConnect: elements['auto-connect'].checked
  }
})));

elements.disconnect.addEventListener('click', () => withAction(() => send({ type: 'disconnectObs' })));
elements['refresh-sources'].addEventListener('click', () => withAction(() => send({ type: 'refreshObsLists' })));
elements['force-update'].addEventListener('click', () => withAction(() => send({ type: 'forceUpdate' })));

elements['create-source'].addEventListener('click', () => withAction(() => send({
  type: 'createTextSource',
  sceneName: elements['scene-name'].value,
  inputName: elements['new-input-name'].value
})));

elements['save-settings'].addEventListener('click', () => withAction(async () => {
  const result = await send({
    type: 'saveSettings',
    values: {
      target: elements.target.value,
      separator: elements.separator.value,
      template: elements.template.value,
      autoTarget: elements['auto-target'].checked,
      autoConnect: elements['auto-connect'].checked,
      inputName: elements['input-name'].value
    }
  });
  formDirty = false;
  return result;
}));

const updatePreview = () => {
  elements.preview.textContent = CounterUtils.formatCounter(
    elements['manual-current'].value || 0,
    elements.target.value,
    elements.separator.value,
    elements.template.value
  ) || '入力内容を確認してください';
};

['manual-current', 'target', 'separator', 'template'].forEach(id => elements[id].addEventListener('input', updatePreview));
['target', 'separator', 'template', 'auto-target', 'auto-connect', 'input-name'].forEach(id => {
  elements[id].addEventListener('input', () => { formDirty = true; });
  elements[id].addEventListener('change', () => { formDirty = true; });
});

elements['reset-settings'].addEventListener('click', () => {
  if (!confirm('保存した設定をすべて削除しますか？')) return;
  withAction(() => send({ type: 'resetSettings' }));
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'stateChanged' && !formDirty) loadState().catch(error => showMessage(error.message, true));
});

loadState().catch(error => showMessage(error.message, true));

const { extractSubscriberCount, findBestSubscriberCandidate } = CounterUtils;

let selectedElement = null;
let selectedSelector = '';
let valueObserver = null;
let documentObserver = null;
let selecting = false;
let lastValue = null;
let guideElement = null;

const showSelectionGuide = () => {
  guideElement?.remove();
  guideElement = document.createElement('div');
  guideElement.textContent = '登録者数の数字だけをドラッグして選択してください　Escで中止';
  Object.assign(guideElement.style, {
    position: 'fixed',
    zIndex: '2147483647',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '12px 18px',
    color: '#ffffff',
    background: '#181b1b',
    fontFamily: 'sans-serif',
    fontSize: '14px',
    fontWeight: '700',
    boxShadow: '0 2px 8px rgba(0, 0, 0, .2)'
  });
  document.documentElement.append(guideElement);
};

const selectorFor = element => {
  if (element.id && /^[A-Za-z][\w:-]*$/.test(element.id)) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let current = element;
  while (current && current !== document.body && parts.length < 8) {
    let part = current.localName;
    if (!part) break;
    const stableAttribute = ['data-testid'].find(name => current.hasAttribute(name));
    if (stableAttribute) {
      const value = CSS.escape(current.getAttribute(stableAttribute));
      part += `[${stableAttribute}="${value}"]`;
    } else if (current.parentElement) {
      const siblings = [...current.parentElement.children].filter(item => item.localName === current.localName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(' > ');
};

const readSelectedValue = () => {
  if (!selectedElement?.isConnected) {
    chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '選択要素を再検出中' });
    return;
  }
  const value = subscriberValueForElement(selectedElement);
  if (value === null || value === lastValue) return;
  lastValue = value;
  chrome.runtime.sendMessage({ type: 'subscriberUpdate', value, selector: selectedSelector });
};

const observeElement = element => {
  valueObserver?.disconnect();
  selectedElement = element;
  valueObserver = new MutationObserver(readSelectedValue);
  valueObserver.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title']
  });
  readSelectedValue();
};

const restoreSelectedElement = () => {
  if (!selectedSelector) return false;
  let element = null;
  try {
    element = document.querySelector(selectedSelector);
  } catch {
    return false;
  }
  if (!element) return false;
  observeElement(element);
  chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '自動取得中' });
  return true;
};

const ensureDocumentObserver = () => {
  if (documentObserver) return;
  documentObserver = new MutationObserver(() => {
    if (!selectedElement?.isConnected) restoreSelectedElement();
  });
  documentObserver.observe(document.documentElement, { childList: true, subtree: true });
};

const stopSelection = () => {
  selecting = false;
  guideElement?.remove();
  guideElement = null;
  document.removeEventListener('mouseup', onSelectionMouseUp);
  document.removeEventListener('keydown', onSelectionKey, true);
};

const onSelectionKey = event => {
  if (event.key === 'Escape') {
    stopSelection();
    chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '選択をキャンセル' });
  }
};

const subscriberTextsForElement = element => [
  element.textContent,
  element.innerText,
  element.getAttribute('aria-label'),
  element.getAttribute('title')
];

const subscriberValueForElement = element => {
  const candidate = findBestSubscriberCandidate(
    subscriberTextsForElement(element).map(extractSubscriberCount)
  );
  return candidate?.value ?? null;
};

const expandSelectedNumber = (element, selectedValue) => {
  const selectedDigits = String(selectedValue);
  let current = element;
  let best = { element, value: selectedValue };
  for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
    const value = subscriberValueForElement(current);
    if (value !== null && String(value).endsWith(selectedDigits) && String(value).length > String(best.value).length) {
      best = { element: current, value };
    }
    current = current.parentElement;
  }
  return best;
};

const onSelect = () => {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim() || '';
  const selectedValue = extractSubscriberCount(selectedText);
  if (selectedValue === null || !selection?.rangeCount || selection.isCollapsed) {
    chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '登録者数の数字だけをドラッグ選択してください' });
    return;
  }

  const range = selection.getRangeAt(0);
  const commonNode = range.commonAncestorContainer;
  const rangeElement = commonNode.nodeType === Node.ELEMENT_NODE ? commonNode : commonNode.parentElement;
  if (!rangeElement || rangeElement === document.body || rangeElement === document.documentElement) {
    chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '数字部分だけを狭くドラッグ選択してください' });
    return;
  }

  const { element, value } = expandSelectedNumber(rangeElement, selectedValue);

  selectedSelector = selectorFor(element);
  stopSelection();
  lastValue = value;
  observeElement(element);
  ensureDocumentObserver();
  chrome.runtime.sendMessage({ type: 'selectionSaved', selector: selectedSelector, value });
  selection.removeAllRanges();
};

const onSelectionMouseUp = () => {
  setTimeout(onSelect, 0);
};

const startSelection = () => {
  if (selecting) return;
  selecting = true;
  showSelectionGuide();
  document.addEventListener('mouseup', onSelectionMouseUp);
  document.addEventListener('keydown', onSelectionKey, true);
  chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '登録者数をドラッグ選択してください。Escで中止できます' });
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'startSelection') {
    startSelection();
    sendResponse({ ok: true });
  }
  if (message.type === 'restoreSelection') {
    selectedSelector = message.selector || '';
    ensureDocumentObserver();
    sendResponse({ ok: restoreSelectedElement() });
  }
  if (message.type === 'getContentStatus') {
    sendResponse({ active: Boolean(selectedElement?.isConnected), selecting });
  }
  return true;
});

chrome.storage.local.get(CounterUtils.defaults).then(settings => {
  selectedSelector = settings.selectedSelector || '';
  if (selectedSelector) {
    ensureDocumentObserver();
    if (!restoreSelectedElement()) chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '再選択が必要です' });
  }
});

setInterval(() => {
  if (!selectedElement?.isConnected) return;
  readSelectedValue();
}, 1000);

setInterval(() => {
  if (!selectedElement?.isConnected) return;
  chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '自動取得中' }).catch(() => {});
}, 15000);

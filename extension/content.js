const { extractSubscriberCount } = CounterUtils;

let selectedElement = null;
let selectedSelector = '';
let valueObserver = null;
let documentObserver = null;
let selecting = false;
let hoveredElement = null;
let lastValue = null;

const selectorFor = element => {
  if (element.id && /^[A-Za-z][\w:-]*$/.test(element.id)) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let current = element;
  while (current && current !== document.body && parts.length < 8) {
    let part = current.localName;
    if (!part) break;
    const stableAttribute = ['data-testid', 'aria-label'].find(name => current.hasAttribute(name));
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
  const value = extractSubscriberCount(selectedElement.textContent);
  if (value === null || value === lastValue) return;
  lastValue = value;
  chrome.runtime.sendMessage({ type: 'subscriberUpdate', value, selector: selectedSelector });
};

const observeElement = element => {
  valueObserver?.disconnect();
  selectedElement = element;
  valueObserver = new MutationObserver(readSelectedValue);
  valueObserver.observe(element, { childList: true, subtree: true, characterData: true });
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

const clearHighlight = () => {
  if (hoveredElement) hoveredElement.style.removeProperty('outline');
  hoveredElement = null;
};

const stopSelection = () => {
  selecting = false;
  clearHighlight();
  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('click', onSelect, true);
  document.removeEventListener('keydown', onSelectionKey, true);
};

const onMouseOver = event => {
  clearHighlight();
  hoveredElement = event.target;
  hoveredElement.style.setProperty('outline', '2px solid #1676a7', 'important');
};

const onSelectionKey = event => {
  if (event.key === 'Escape') {
    stopSelection();
    chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '選択をキャンセル' });
  }
};

const onSelect = event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  const element = event.target;
  const value = extractSubscriberCount(element.textContent);
  if (value === null) {
    chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '整数が表示された要素を選択してください' });
    return;
  }
  selectedSelector = selectorFor(element);
  stopSelection();
  observeElement(element);
  ensureDocumentObserver();
  chrome.runtime.sendMessage({ type: 'selectionSaved', selector: selectedSelector, value });
};

const startSelection = () => {
  if (selecting) return;
  selecting = true;
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onSelect, true);
  document.addEventListener('keydown', onSelectionKey, true);
  chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '数字をクリックしてください。Escで中止できます' });
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
  chrome.runtime.sendMessage({ type: 'youtubeStatus', status: '自動取得中' }).catch(() => {});
}, 15000);

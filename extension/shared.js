(function (root) {
  const normalizeDigits = value => String(value ?? '')
    .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/[，,\s]/g, '');

  const parseSubscriberCount = value => {
    const normalized = normalizeDigits(value);
    if (!/^\d+$/.test(normalized)) return null;
    const number = Number(normalized);
    if (!Number.isSafeInteger(number) || number < 0) return null;
    return number;
  };

  const parsePositiveInteger = value => {
    const number = parseSubscriberCount(value);
    return number !== null && number > 0 ? number : null;
  };

  const extractSubscriberCount = value => {
    let normalized = String(value ?? '')
      .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
      .replace(/，/g, ',')
      .replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (/\d+(?:\.\d+)?\s*(?:K|M|B|万|億)/i.test(normalized) || /\d+\.\d+/.test(normalized)) return null;

    const digitTokens = normalized.match(/\d+/g);
    if (digitTokens?.length > 1 && digitTokens.every(token => token.length === 1)) {
      normalized = normalized.replace(/(?<=\d)\s+(?=\d)/g, '');
    }

    const matches = normalized.match(/\d{1,3}(?:,\d{3})+|\d+/g);
    if (!matches || matches.length !== 1) return null;
    return parseSubscriberCount(matches[0]);
  };

  const parseSelectedSubscriberCount = value => {
    const normalized = String(value ?? '')
      .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
      .replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (!normalized || /[^\d\p{P}\p{Z}\s]/u.test(normalized)) return null;
    const digits = normalized.replace(/\D/g, '');
    return digits ? parseSubscriberCount(digits) : null;
  };

  const stabilizeSubscriberCount = (observed, previous, preferTransition = false) => {
    const safeObserved = parseSubscriberCount(observed);
    const safePrevious = parseSubscriberCount(previous);
    if (safeObserved === null || safePrevious === null) return safeObserved;
    const observedDigits = String(safeObserved);
    const previousDigits = String(safePrevious);
    if (observedDigits.length <= previousDigits.length) return safeObserved;

    if (observedDigits.startsWith(previousDigits)) {
      const remainder = observedDigits.slice(previousDigits.length);
      const transitionCandidates = [];
      if (remainder && remainder[0] !== '0') transitionCandidates.push(Number(remainder));
      if (remainder.length < previousDigits.length) {
        transitionCandidates.push(Number(previousDigits.slice(0, -remainder.length) + remainder));
      }
      const transition = transitionCandidates
        .filter(value => value !== safePrevious && Math.abs(value - safePrevious) <= 10)
        .sort((a, b) => Math.abs(a - safePrevious) - Math.abs(b - safePrevious))[0];
      if (transition !== undefined) return transition;
    }

    const lengths = [previousDigits.length, previousDigits.length + 1];
    const candidates = new Set();
    const collect = (start, remaining, value) => {
      if (remaining === 0) {
        if (value[0] !== '0') candidates.add(Number(value));
        return;
      }
      for (let index = start; index <= observedDigits.length - remaining; index += 1) {
        collect(index + 1, remaining - 1, value + observedDigits[index]);
      }
    };
    lengths.filter(length => length <= observedDigits.length).forEach(length => collect(0, length, ''));

    const next = [...candidates]
      .filter(value => value !== safePrevious && Math.abs(value - safePrevious) <= 10)
      .sort((a, b) => Math.abs(a - safePrevious) - Math.abs(b - safePrevious))[0];
    if (preferTransition && next !== undefined) return next;
    if (candidates.has(safePrevious)) return safePrevious;
    if (next !== undefined) return next;
    return safeObserved;
  };

  const extractLikelySubscriberCount = value => {
    let normalized = String(value ?? '')
      .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
      .replace(/，/g, ',')
      .replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (/\d+(?:\.\d+)?\s*(?:K|M|B|万|億)/i.test(normalized) || /\d+\.\d+/.test(normalized)) return null;

    normalized = normalized.replace(/(?:\d\s+){2,}\d/g, sequence => sequence.replace(/\s/g, ''));
    const matches = normalized.match(/\d{1,3}(?:,\d{3})+|\d+/g) || [];
    let best = null;
    for (const match of matches) {
      const count = parseSubscriberCount(match);
      if (count === null) continue;
      const digitCount = String(count).length;
      if (!best || digitCount > best.digitCount) best = { value: count, digitCount };
    }
    return best?.value ?? null;
  };

  const findBestSubscriberCandidate = values => {
    let best = null;
    values.forEach((value, index) => {
      const count = extractSubscriberCount(value);
      if (count === null) return;
      const digitCount = String(count).length;
      if (!best || digitCount > best.digitCount) best = { index, value: count, digitCount };
    });
    return best && { index: best.index, value: best.value };
  };

  const formatCounter = (current, target, separator = ' / ', template = '{current}{separator}{target}') => {
    const safeCurrent = parseSubscriberCount(current);
    const safeTarget = parsePositiveInteger(target);
    if (safeCurrent === null || safeTarget === null) return '';
    const safeSeparator = String(separator).slice(0, 12);
    return String(template || '{current}{separator}{target}')
      .replaceAll('{current}', safeCurrent.toLocaleString('ja-JP'))
      .replaceAll('{target}', safeTarget.toLocaleString('ja-JP'))
      .replaceAll('{separator}', safeSeparator)
      .slice(0, 160);
  };

  const nextAutomaticTarget = (current, target) => {
    const safeCurrent = parseSubscriberCount(current);
    const safeTarget = parsePositiveInteger(target);
    if (safeCurrent === null || safeTarget === null || safeCurrent < safeTarget) return safeTarget;
    const step = safeTarget < 100 ? 10 : safeTarget < 1000 ? 100 : safeTarget < 10000 ? 1000 : 10000;
    return Math.ceil((safeCurrent + 1) / step) * step;
  };

  const isLocalHost = host => ['127.0.0.1', 'localhost'].includes(String(host).trim().toLowerCase());

  const validatePort = value => {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  };

  const buildObsUrl = (host, port) => {
    if (!isLocalHost(host)) throw new Error('接続先はlocalhostのみ指定できます。');
    const safePort = validatePort(port);
    if (!safePort) throw new Error('ポート番号が正しくありません。');
    return `ws://${host}:${safePort}`;
  };

  const bytesToBase64 = buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  };

  const sha256Base64 = async value => {
    const data = new TextEncoder().encode(value);
    return bytesToBase64(await crypto.subtle.digest('SHA-256', data));
  };

  const createObsAuthentication = async (password, salt, challenge) => {
    const secret = await sha256Base64(`${password}${salt}`);
    return sha256Base64(`${secret}${challenge}`);
  };

  const defaults = Object.freeze({
    host: '127.0.0.1',
    port: 4455,
    target: 1000,
    separator: ' / ',
    template: '{current}{separator}{target}',
    autoTarget: false,
    autoConnect: true,
    savePassword: false,
    password: '',
    inputName: '',
    current: null,
    lastSentText: '',
    selectedTabId: null,
    selectedSelector: '',
    youtubeStatus: '未選択',
    lastCapturedAt: null
  });

  root.CounterUtils = {
    normalizeDigits,
    parseSubscriberCount,
    parsePositiveInteger,
    extractSubscriberCount,
    parseSelectedSubscriberCount,
    stabilizeSubscriberCount,
    extractLikelySubscriberCount,
    findBestSubscriberCandidate,
    formatCounter,
    nextAutomaticTarget,
    isLocalHost,
    validatePort,
    buildObsUrl,
    createObsAuthentication,
    defaults
  };
})(globalThis);

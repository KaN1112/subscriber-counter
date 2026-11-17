const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runObsIntegrationTest } = require('./obs-integration-test.js');

require('../extension/shared.js');

const {
  parseSubscriberCount,
  parsePositiveInteger,
  extractSubscriberCount,
  extractLikelySubscriberCount,
  findBestSubscriberCandidate,
  formatCounter,
  nextAutomaticTarget,
  buildObsUrl,
  createObsAuthentication
} = globalThis.CounterUtils;

const tests = [
  () => assert.equal(parseSubscriberCount('1,234'), 1234),
  () => assert.equal(parseSubscriberCount('１，２３４'), 1234),
  () => assert.equal(parseSubscriberCount(' 777 '), 777),
  () => assert.equal(parseSubscriberCount('1.2万'), null),
  () => assert.equal(parseSubscriberCount('-1'), null),
  () => assert.equal(parsePositiveInteger('0'), null),
  () => assert.equal(extractSubscriberCount('登録者 1,234人'), 1234),
  () => assert.equal(extractSubscriberCount('1,234 subscribers'), 1234),
  () => assert.equal(extractSubscriberCount('登録者 1 6 5 0 人'), 1650),
  () => assert.equal(extractSubscriberCount('登録者 1\n6\n5\n0 人'), 1650),
  () => assert.equal(extractSubscriberCount('登録者 1\u200b6\u200b5\u200b0 人'), 1650),
  () => assert.equal(extractSubscriberCount('1.2K subscribers'), null),
  () => assert.equal(extractSubscriberCount('100 / 1000'), null),
  () => assert.equal(extractLikelySubscriberCount('登録者 1 6 5 0　過去28日 12'), 1650),
  () => assert.equal(extractLikelySubscriberCount('登録者 1,650　目標 1000'), 1650),
  () => assert.equal(extractLikelySubscriberCount('5'), 5),
  () => assert.deepEqual(
    findBestSubscriberCandidate(['5', '1650', '登録者 1650人', '1650 1000']),
    { index: 1, value: 1650 }
  ),
  () => assert.deepEqual(
    findBestSubscriberCandidate(['０', '１，６５０', '登録者 １，６５０人']),
    { index: 1, value: 1650 }
  ),
  () => assert.equal(formatCounter(777, 1000, ' / '), '777 / 1,000'),
  () => assert.equal(formatCounter(777, 1000, '｜', '{current}{separator}{target}人'), '777｜1,000人'),
  () => assert.equal(nextAutomaticTarget(1000, 1000), 2000),
  () => assert.equal(nextAutomaticTarget(777, 1000), 1000),
  () => assert.equal(buildObsUrl('127.0.0.1', 4455), 'ws://127.0.0.1:4455'),
  () => assert.throws(() => buildObsUrl('example.com', 4455)),
  () => assert.throws(() => buildObsUrl('localhost', 70000)),
  async () => {
    const { createHash } = require('node:crypto');
    const password = 'supersecretpassword';
    const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
    const challenge = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';
    const secret = createHash('sha256').update(`${password}${salt}`).digest('base64');
    const expected = createHash('sha256').update(`${secret}${challenge}`).digest('base64');
    assert.equal(await createObsAuthentication(password, salt, challenge), expected);
  },
  () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.minimum_chrome_version, '116');
    assert.deepEqual(manifest.host_permissions, ['https://studio.youtube.com/*']);
  },
  () => {
    const serviceWorker = fs.readFileSync(path.join(__dirname, '../extension/service-worker.js'), 'utf8');
    assert.match(serviceWorker, /GetInputList/);
    assert.match(serviceWorker, /SetInputSettings/);
    assert.match(serviceWorker, /CreateInput/);
    assert.match(serviceWorker, /GetVersion/);
    assert.match(serviceWorker, /20000/);
    assert.match(serviceWorker, /overlay: true/);
    assert.match(serviceWorker, /更新後に登録者数を再選択してください/);
    assert.match(serviceWorker, /OBS更新失敗/);
    const contentScript = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
    assert.match(contentScript, /window\.getSelection\(\)/);
    assert.match(contentScript, /addEventListener\('mouseup'/);
    assert.match(contentScript, /}, 1000\)/);
  }
];

const run = async () => {
  let passed = 0;
  for (const test of tests) {
    await test();
    passed += 1;
  }
  await runObsIntegrationTest();
  passed += 1;
  process.stdout.write(`${passed} tests passed\n`);
};

run().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

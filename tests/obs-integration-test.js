const assert = require('node:assert/strict');

require('../extension/shared.js');

class MockObsWebSocket {
  constructor(password) {
    this.password = password;
    this.salt = 'mock-salt';
    this.challenge = 'mock-challenge';
    this.handlers = new Map();
    this.updates = [];
  }

  addEventListener(type, handler) {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  emit(type, data) {
    for (const handler of this.handlers.get(type) || []) handler({ data: JSON.stringify(data) });
  }

  start() {
    this.emit('message', {
      op: 0,
      d: {
        obsWebSocketVersion: '5.0.0-mock',
        rpcVersion: 1,
        authentication: { salt: this.salt, challenge: this.challenge }
      }
    });
  }

  async send(rawMessage) {
    const message = JSON.parse(rawMessage);
    if (message.op === 1) {
      const expected = await CounterUtils.createObsAuthentication(this.password, this.salt, this.challenge);
      assert.equal(message.d.authentication, expected);
      this.emit('message', { op: 2, d: { negotiatedRpcVersion: 1 } });
      return;
    }
    if (message.op !== 6) return;
    const { requestType, requestId, requestData } = message.d;
    let responseData = {};
    if (requestType === 'GetInputList') {
      responseData = { inputs: [{ inputName: 'OBS登録者カウンター', inputKind: 'text_gdiplus_v2' }] };
    }
    if (requestType === 'SetInputSettings') this.updates.push(requestData);
    this.emit('message', {
      op: 7,
      d: {
        requestType,
        requestId,
        requestStatus: { result: true, code: 100 },
        responseData
      }
    });
  }
}

const runObsIntegrationTest = async () => {
  const socket = new MockObsWebSocket('test-password');
  const requests = new Map();
  let identified = false;
  let inputList = null;

  socket.addEventListener('message', async event => {
    const message = JSON.parse(event.data);
    if (message.op === 0) {
      const authentication = await CounterUtils.createObsAuthentication(
        'test-password',
        message.d.authentication.salt,
        message.d.authentication.challenge
      );
      await socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication } }));
    }
    if (message.op === 2) identified = true;
    if (message.op === 7) {
      requests.set(message.d.requestType, message.d);
      if (message.d.requestType === 'GetInputList') inputList = message.d.responseData.inputs;
    }
  });

  socket.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(identified, true);

  await socket.send(JSON.stringify({
    op: 6,
    d: { requestType: 'GetInputList', requestId: 'list-1', requestData: {} }
  }));
  assert.equal(inputList[0].inputName, 'OBS登録者カウンター');

  await socket.send(JSON.stringify({
    op: 6,
    d: {
      requestType: 'SetInputSettings',
      requestId: 'update-1',
      requestData: {
        inputName: 'OBS登録者カウンター',
        inputSettings: { text: '777 / 1,000' },
        overlay: true
      }
    }
  }));

  assert.equal(requests.get('SetInputSettings').requestStatus.result, true);
  assert.equal(socket.updates[0].inputSettings.text, '777 / 1,000');
  assert.equal(socket.updates[0].overlay, true);
};

module.exports = { runObsIntegrationTest };

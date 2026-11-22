'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createLoopbackSameOriginGuard,
  isLoopbackRequestHostname,
  parseHostHeader
} = require('../utils/same-origin-mutation-guard');

function invokeGuard(headers, method = 'POST') {
  const guard = createLoopbackSameOriginGuard();
  let nextCalled = false;
  let statusCode = null;
  let body = null;
  const req = {
    method,
    get(name) {
      return headers[name.toLowerCase()];
    }
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    }
  };
  guard(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, body };
}

test('allows same-origin loopback mutations', () => {
  const result = invokeGuard({
    host: 'localhost:3456',
    origin: 'http://localhost:3456',
    'sec-fetch-site': 'same-origin'
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
});

test('rejects cross-site form-style mutations even without an API key', () => {
  const result = invokeGuard({
    host: 'localhost:3456',
    origin: 'https://attacker.example',
    'sec-fetch-site': 'cross-site'
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test('rejects DNS-rebinding Host names', () => {
  const result = invokeGuard({
    host: 'attacker.example:3456',
    origin: 'http://attacker.example:3456',
    'sec-fetch-site': 'same-origin'
  }, 'GET');
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test('rejects cross-origin read requests as well as mutations', () => {
  const result = invokeGuard({
    host: '127.0.0.1:3456',
    origin: 'https://attacker.example',
    'sec-fetch-site': 'cross-site'
  }, 'GET');
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test('allows loopback CLI requests without Origin', () => {
  const result = invokeGuard({ host: '127.0.0.1:3456' });
  assert.equal(result.nextCalled, true);
});

test('rejects opaque and malformed Origin values', () => {
  for (const origin of ['null', 'not a URL']) {
    const result = invokeGuard({
      host: 'localhost:3456',
      origin,
      'sec-fetch-site': 'same-origin'
    });
    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 403);
  }
});

test('recognizes only valid loopback request hostnames', () => {
  assert.equal(isLoopbackRequestHostname('localhost'), true);
  assert.equal(isLoopbackRequestHostname('127.0.0.2'), true);
  assert.equal(isLoopbackRequestHostname('::1'), true);
  assert.equal(isLoopbackRequestHostname('127.999.1.1'), false);
  assert.equal(isLoopbackRequestHostname('192.168.1.10'), false);
  assert.equal(isLoopbackRequestHostname('attacker.example'), false);
});

test('parses bracketed IPv6 loopback Host headers', () => {
  assert.deepEqual(parseHostHeader('[::1]:3456'), {
    hostname: '::1',
    authority: '[::1]:3456'
  });
});

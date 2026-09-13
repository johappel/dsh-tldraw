import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function createHost() {
  const tools = new Map();
  const handlers = new Map();
  apply({
    get(name) {
      if (name === 'webServer') return { register(route) { handlers.set(route.path, route.handler); return () => {}; } };
      if (name === 'tools') return { register(tool) { tools.set(tool.name, tool); return () => {}; } };
      if (name === 'sessions') return { get() { return null; } };
      return undefined;
    },
    effect(start) { start(); }
  });
  return { tools, handlers };
}

function api(handler, body) {
  const req = new EventEmitter();
  const response = new Promise((resolve) => {
    const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)); } };
    handler(req, res);
  });
  queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
  return response;
}

function eventStream(handler, sessionId) {
  const req = new EventEmitter();
  req.url = '/dsh-whiteboard/open-events?sessionId=' + encodeURIComponent(sessionId);
  const writes = [];
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (text) => { writes.push(text); };
  res.end = () => {};
  handler(req, res);
  return writes;
}

test('an open request emits one event to the matching session stream', async () => {
  const { tools, handlers } = createHost();
  const writes = eventStream(handlers.get('/dsh-whiteboard/open-events'), 'session-a');
  const signal = await tools.get('whiteboard_request_open').execute({}, { agent: { id: 'session-a' } });
  assert.deepEqual(signal, { accepted: true, requested: true });
  assert.match(writes.at(-1), /event: whiteboard-open/);
  assert.match(writes.at(-1), /"sessionId":"session-a"/);
});

test('a session-bound event stream does not receive another session request', async () => {
  const { tools, handlers } = createHost();
  const writes = eventStream(handlers.get('/dsh-whiteboard/open-events'), 'session-b');
  await tools.get('whiteboard_request_open').execute({}, { agent: { id: 'session-a' } });
  assert.equal(writes.some((text) => text.includes('event: whiteboard-open')), false);
  await tools.get('whiteboard_request_open').execute({}, { agent: { id: 'session-b' } });
  assert.equal(writes.filter((text) => text.includes('event: whiteboard-open')).length, 1);
});

test('a render command is delivered on its session command stream', async () => {
  const { tools, handlers } = createHost();
  const writes = eventStream(handlers.get('/dsh-whiteboard/command-events'), 'session-a');
  await tools.get('whiteboard_render_plan').execute({ op: 'render-plan', plan: {} }, { agent: { id: 'session-a' } });
  assert.match(writes.at(-1), /event: whiteboard-commands/);
  assert.match(writes.at(-1), /"op":"render-plan"/);
});

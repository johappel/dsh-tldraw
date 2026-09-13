import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const previousDshHome = process.env.DSH_HOME;
const testDshHome = mkdtempSync(path.join(tmpdir(), 'dsh-whiteboard-test-'));
process.env.DSH_HOME = testDshHome;
test.after(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(testDshHome, { recursive: true, force: true });
});

function createHost() {
  const tools = new Map();
  const handlers = new Map();
  const sessions = new Map();
  const workspace = process.cwd();
  for (const id of ['session-elements', 'session-a', 'session-b']) {
    sessions.set(id, { id, header: { cwd: workspace } });
  }
  apply({
    get(name) {
      if (name === 'webServer') return { register(route) { handlers.set(route.path, route.handler); return () => {}; } };
      if (name === 'tools') return { register(tool) { tools.set(tool.name, tool); return () => {}; } };
      if (name === 'sessions') return { get(id) { return sessions.get(id) || null; } };
      return undefined;
    },
    effect(start) { start(); }
  });
  return { tools, handlers };
}

test('complete active-page elements survive the host snapshot boundary', async () => {
  const { tools, handlers } = createHost();
  const elements = [
    { id: 'shape:heart', type: 'geo', geo: 'heart', text: 'Hoffnung', position: { x: 10, y: 20 } },
    { id: 'shape:text', type: 'text', text: 'Einfacher Text', position: { x: 30, y: 40 } },
  ];
  assert.deepEqual(await api(handlers.get('/dsh-whiteboard/api'), {
    method: 'wb-snapshot',
    args: { sessionId: 'session-elements', elements, notes: [], frames: [], arrows: [], selection: [] },
  }), { ok: true });
  const state = await tools.get('whiteboard_state').execute({}, { agent: { id: 'session-elements' } });
  assert.deepEqual(state.snapshot.elements, elements);
});

test('one workspace has one board across multiple sessions and unknown sessions fail closed', async () => {
  const { handlers } = createHost();
  const board = (sessionId) => api(handlers.get('/dsh-whiteboard/api'), {
    method: 'wb-board', args: { sessionId }
  });
  const boardA = await board('session-a');
  const boardB = await board('session-b');
  assert.equal(boardA.ok, true);
  assert.equal(boardA.boardId, boardB.boardId);
  assert.equal((await board('missing')).ok, false);
});

test('durable saves are restricted to the session workspace board', async () => {
  const { handlers } = createHost();
  const emptySnapshot = { store: { records: [] } };
  const rejected = await api(handlers.get('/dsh-whiteboard/api'), {
    method: 'wb-save',
    args: { boardId: 'workspace-00000000000000000000000000000000', sessionId: 'session-a', expectedVersion: 0, snapshot: emptySnapshot }
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Session-Workspace/);
});

function api(handler, body) {
  const req = new EventEmitter();
  const response = new Promise((resolve) => {
    const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)); } };
    handler(req, res);
  });
  queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
  return response;
}

function staticRequest(handler, url) {
  const req = new EventEmitter();
  req.url = url;
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body: String(body || '') }); }
    };
    handler(req, res);
  });
}

test('the browser runtime is served locally and is not a general file route', async () => {
  const { handlers } = createHost();
  const runtime = await staticRequest(handlers.get('/dsh-whiteboard'), '/dsh-whiteboard/runtime.mjs');
  assert.equal(runtime.status, 200);
  assert.match(runtime.headers['Content-Type'], /javascript/);
  assert.match(runtime.body, /Tldraw/);
  const denied = await staticRequest(handlers.get('/dsh-whiteboard'), '/dsh-whiteboard/runtime/other.mjs');
  assert.equal(denied.status, 404);
});

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
	const accepted = await tools.get('whiteboard_render_plan').execute({ op: 'render-plan', plan: {} }, { agent: { id: 'session-a' } });
	assert.equal(accepted.accepted, true);
	assert.match(accepted.commandId, /^[A-Za-z0-9._:-]+$/);
	assert.match(writes.at(-1), /event: whiteboard-commands/);
	assert.match(writes.at(-1), /"op":"render-plan"/);
	assert.match(writes.at(-1), new RegExp('"commandId":"' + accepted.commandId + '"'));
});

test('command results stay attached to the matching session snapshot', async () => {
  const { tools, handlers } = createHost();
  eventStream(handlers.get('/dsh-whiteboard/command-events'), 'session-a');
  eventStream(handlers.get('/dsh-whiteboard/command-events'), 'session-b');
  const stateSnapshot = (sessionId, commandId) => api(handlers.get('/dsh-whiteboard/api'), {
    method: 'wb-snapshot',
    args: { sessionId, notes: [{ id: 'note:' + sessionId, text: sessionId }], commandResults: [{ commandId, op: 'render-plan', ok: true }] }
  });

  assert.deepEqual(await stateSnapshot('session-a', 'cmd-a'), { ok: true });
  assert.deepEqual(await stateSnapshot('session-b', 'cmd-b'), { ok: true });

  const stateA = await tools.get('whiteboard_state').execute({}, { agent: { id: 'session-a' } });
  const stateB = await tools.get('whiteboard_state').execute({}, { agent: { id: 'session-b' } });
  assert.equal(stateA.snapshot.notes[0].text, 'session-b');
  assert.equal(stateB.snapshot.notes[0].text, 'session-b');
  assert.equal(stateA.snapshot.commandResults[0].commandId, 'cmd-a');
  assert.equal(stateB.snapshot.commandResults[0].commandId, 'cmd-b');
});

test('a command channel is connected but becomes live only after its first snapshot', async () => {
  const { tools, handlers } = createHost();
  eventStream(handlers.get('/dsh-whiteboard/command-events'), 'session-a');

  const before = await tools.get('whiteboard_state').execute({}, { agent: { id: 'session-a' } });
  assert.equal(before.connected, true);
  assert.equal(before.live, false);
  assert.equal(before.available, false);
  assert.match(before.hint, /erste Live-Snapshot/);

  await api(handlers.get('/dsh-whiteboard/api'), {
    method: 'wb-snapshot', args: { sessionId: 'session-a', notes: [], frames: [], arrows: [], selection: [] }
  });
  const after = await tools.get('whiteboard_state').execute({}, { agent: { id: 'session-a' } });
  assert.equal(after.connected, true);
  assert.equal(after.live, true);
  assert.equal(after.available, true);
});

test('an idle open board remains writable after its snapshot is older than 15 seconds', async () => {
  const { tools, handlers } = createHost();
  const writes = eventStream(handlers.get('/dsh-whiteboard/command-events'), 'session-a');
  await api(handlers.get('/dsh-whiteboard/api'), {
    method: 'wb-snapshot', args: { sessionId: 'session-a', notes: [], frames: [], arrows: [], selection: [] }
  });

  const realNow = Date.now;
  Date.now = () => realNow() + 16_000;
  try {
    const state = await tools.get('whiteboard_state').execute({}, { agent: { id: 'session-a' } });
    assert.equal(state.connected, true);
    assert.equal(state.live, true);
    const accepted = await tools.get('whiteboard_render_plan').execute({ op: 'render-plan', plan: {} }, { agent: { id: 'session-a' } });
    assert.equal(accepted.accepted, true);
    assert.match(writes.at(-1), /event: whiteboard-commands/);
    assert.match(writes.at(-1), new RegExp('"commandId":"' + accepted.commandId + '"'));
  } finally {
    Date.now = realNow;
  }
});

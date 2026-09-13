// dsh-whiteboard — Host half (ESM)
// Converted from the dynamic spike plugin tldraw-3/pkg-23 (see ../../docs/SPIKE-REPORT.md)
import path from 'node:path';
import { boardIdForWorkspace, createSnapshotStore } from './snapshot-store.mjs';

export const inject = ['webServer'];

export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    console.error('[dsh-whiteboard] webServer fehlt — API-Routen können nicht registriert werden');
    return;
  }
  const toolsReg = ctx.get('tools');
  const sessions = ctx.get('sessions');
  const dshHome = process.env.DSH_HOME || process.cwd();
  const snapshotStore = createSnapshotStore({ root: path.join(dshHome, 'whiteboard-snapshots') });

  const state = { queue: [], snapshot: null, snapshots: new Map(), openRequests: new Map(), lastCommandResults: [], lastSeenAt: 0, lastSeenBySession: new Map(), sessionId: null };

  function workspaceForSession(sessionId) {
    try {
      const session = sessionId && sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null;
      const cwd = session?.header?.cwd;
      if (cwd) return String(cwd);
    } catch (error) {}
    return process.cwd();
  }

  function boardForSession(sessionId) {
    const workspace = workspaceForSession(sessionId);
    return { boardId: boardIdForWorkspace(workspace), workspace };
  }

  function captureSession(exec) {
    try {
      if (exec && exec.agent && exec.agent.id) state.sessionId = String(exec.agent.id);
    } catch (e) {}
  }

  function pushCommand(op, extra) {
    const cmd = { op, at: Date.now(), sessionId: state.sessionId };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        const v = extra[k];
        if (v !== undefined) cmd[k] = v;
      }
    }
    state.queue.push(cmd);
    if (state.sessionId) state.openRequests.set(state.sessionId, Date.now());
    return { accepted: true, op, pending: state.queue.length };
  }

  async function dispatch(method, args) {
    switch (method) {
      case 'wb-board': {
        const sessionId = args && args.sessionId ? String(args.sessionId).replace(/^dsh-whiteboard-/, '') : null;
        const board = boardForSession(sessionId);
        const record = await snapshotStore.load(board.boardId);
        return {
          ok: true,
          boardId: board.boardId,
          version: record?.version || 0,
          savedAt: record?.savedAt || null,
          snapshot: record?.snapshot || null
        };
      }
      case 'wb-session-key':
        return {
          key: state.sessionId ? 'dsh-whiteboard-' + state.sessionId : null,
          sessionId: state.sessionId
        };
      case 'wb-open-poll': {
        const requestedSessionId = args && args.sessionId ? String(args.sessionId).replace(/^dsh-whiteboard-/, '') : null;
        const now = Date.now();
        for (const [sessionId, requestedAt] of state.openRequests) {
          if (now - requestedAt > 15000) state.openRequests.delete(sessionId);
        }
        if (requestedSessionId && state.openRequests.has(requestedSessionId)) {
          state.openRequests.delete(requestedSessionId);
          return { open: true };
        }
        // With no session identity, fail closed when more than one session has
        // pending work; a browser must never open another workspace's board.
        if (!requestedSessionId) {
          const pendingSessions = [...new Set([
            ...state.queue.map((command) => command.sessionId),
            ...state.openRequests.keys()
          ].filter(Boolean))];
          if (pendingSessions.length === 1 && state.openRequests.has(pendingSessions[0])) {
            state.openRequests.delete(pendingSessions[0]);
            return { open: true };
          }
        }
        return { open: false };
      }
      case 'wb-poll':
        state.lastSeenAt = Date.now();
        {
          const requestedSessionId = args && args.sessionId ? String(args.sessionId).replace(/^dsh-whiteboard-/, '') : null;
          if (requestedSessionId) state.lastSeenBySession.set(requestedSessionId, Date.now());
          const commands = requestedSessionId ? state.queue.filter((command) => command.sessionId === requestedSessionId) : state.queue;
          state.queue = requestedSessionId ? state.queue.filter((command) => command.sessionId !== requestedSessionId) : [];
          return { commands };
        }
      case 'wb-snapshot':
        state.lastSeenAt = Date.now();
        if (!args || typeof args !== 'object') return { ok: false };
        const snapshot = {
          counts: args.counts || null,
          notes: Array.isArray(args.notes) ? args.notes : [],
          frames: Array.isArray(args.frames) ? args.frames : [],
          arrows: Array.isArray(args.arrows) ? args.arrows : [],
          proposals: Array.isArray(args.proposals) ? args.proposals : [],
          selection: Array.isArray(args.selection) ? args.selection : [],
          page: args.page || null
        };
        const snapshotSessionId = args.sessionId ? String(args.sessionId).replace(/^dsh-whiteboard-/, '') : state.sessionId;
        if (snapshotSessionId) {
          state.snapshots.set(snapshotSessionId, snapshot);
          state.lastSeenBySession.set(snapshotSessionId, Date.now());
        }
        state.snapshot = snapshot;
        state.lastCommandResults = Array.isArray(args.commandResults) ? args.commandResults.slice(-10) : [];
        return { ok: true };
      case 'wb-save': {
        const boardId = args && args.boardId ? String(args.boardId) : '';
        const expectedVersion = Number.isInteger(args?.expectedVersion) && args.expectedVersion >= 0 ? args.expectedVersion : -1;
        if (expectedVersion < 0 || !args?.snapshot || typeof args.snapshot !== 'object') {
          return { ok: false, error: 'boardId, expectedVersion und snapshot sind erforderlich' };
        }
        return snapshotStore.save(boardId, expectedVersion, args.snapshot);
      }
      default:
        return { error: 'unknown method: ' + method };
    }
  }

  function isLive(sessionId) {
    const seenAt = sessionId && state.lastSeenBySession.has(sessionId) ? state.lastSeenBySession.get(sessionId) : state.lastSeenAt;
    return seenAt > 0 && (Date.now() - seenAt) < 15000;
  }

  function jsonRender(args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }];
  }

  // Tool results cross the DSH boundary directly. Keep the existing
  // whiteboard_state contract, but remove undefined/non-JSON values before
  // DSH validates the result. This is deliberately generic and does not
  // change the board store or the M1 adapter.
  function lossless(value, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : null;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
    const refs = seen || new Set();
    if (refs.has(value)) throw new TypeError('cyclic whiteboard tool result');
    refs.add(value);
    let result;
    if (Array.isArray(value)) {
      result = value.map((item) => {
        const projected = lossless(item, refs);
        return projected === undefined ? null : projected;
      });
    } else {
      result = {};
      for (const key of Object.keys(value)) {
        const projected = lossless(value[key], refs);
        if (projected !== undefined) result[key] = projected;
      }
    }
    refs.delete(value);
    return result;
  }

  const outputObject = { schema: { type: 'object', additionalProperties: true }, render: jsonRender };

  function readBody(req) {
    return new Promise(function (resolve, reject) {
      let data = '';
      req.on('data', function (chunk) {
        data += chunk;
        if (data.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
      });
      req.on('end', function () {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: '/dsh-whiteboard/api',
    handler(req, res) {
      readBody(req).then(function (body) {
        let result;
        Promise.resolve().then(() => dispatch(body && body.method, body && body.args)).then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        }).catch((e) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: String((e && e.message) || e) }));
        });
      }).catch(function () {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"bad request"}');
      });
    }
  });
  ctx.effect(() => dispose, 'dsh-whiteboard:api');

  const tools = [
    {
      name: 'whiteboard_request_open',
      description: 'Internal host-to-browser signal: request that the session-bound Whiteboard tab is opened. This does not change board content and is hidden from the Companion.',
      parameters: { type: 'object', properties: {} },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        if (!state.sessionId) return { accepted: false, reason: 'sessionId fehlt' };
        state.openRequests.set(state.sessionId, Date.now());
        return { accepted: true, requested: true };
      }
    },
    {
      name: 'whiteboard_state',
      description: 'Read the current live state of the shared tldraw whiteboard in the user\'s browser. Returns counts, notes (id, text, position, parentId, actor, proposal flag, movedBy), frames with memberIds, arrows, open cluster proposals, the CURRENT SELECTION of the human (selection: array of {id, kind, text}) and the active page (id/name/pageCount). Use the selection to see what the human is actively looking at. ALWAYS call this first, before any other whiteboard tool, and use the returned note ids/texts to reference existing ideas. Only the ACTIVE tldraw page is visible; page.pageCount tells you how many pages exist. live=false means the Whiteboard tab is not currently open in the browser; tell the user to open the "🧩 Whiteboard" tab.',
      parameters: { type: 'object', properties: {} },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        const snapshot = state.sessionId ? (state.snapshots.get(state.sessionId) || null) : null;
        if (!snapshot || !isLive(state.sessionId)) {
          return { live: isLive(state.sessionId), available: !!snapshot, snapshot, hint: 'Kein Live-Snapshot. Der Mensch muss den Whiteboard-Tab in der DSH-Weboberfläche geöffnet haben.' };
        }
        return lossless({ live: true, available: true, snapshot, lastCommandResults: state.lastCommandResults });
      }
    },
    {
      name: 'whiteboard_add_note',
      description: 'Add ONE idea note to the shared whiteboard as the agent (rendered violet, attributed to the agent, fully visible to the human). Use for contributing your own ideas during brainstorming. If x/y are omitted the note is placed at a free spot. One idea per call. Adds to the currently active page.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Short idea text for the note.' },
          x: { type: 'number', description: 'Optional x position on the canvas.' },
          y: { type: 'number', description: 'Optional y position on the canvas.' }
        },
        required: ['text']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        const text = String((args && args.text) || '').trim();
        if (!text) return { accepted: false, reason: 'text ist leer' };
        return pushCommand('add-note', { text: text.slice(0, 300), x: typeof args.x === 'number' ? args.x : null, y: typeof args.y === 'number' ? args.y : null });
      }
    },
    {
      name: 'whiteboard_rename_cluster',
      description: 'Rename an EXISTING cluster frame on the shared whiteboard (e.g. after the human asked for a different cluster name). Prefer this over creating a second proposal. Pass the frameId from whiteboard_state and the new name (without the "🤖 Vorschlag:" prefix — it is kept automatically while the frame is still a proposal).',
      parameters: {
        type: 'object',
        properties: {
          frameId: { type: 'string', description: 'Frame id of the existing cluster (from whiteboard_state frames).' },
          name: { type: 'string', description: 'New cluster name, e.g. "Guter Unterricht".' }
        },
        required: ['frameId', 'name']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        const frameId = args && args.frameId ? String(args.frameId) : '';
        const name = args && args.name ? String(args.name).trim() : '';
        if (!frameId || !name) return { accepted: false, reason: 'frameId und name sind erforderlich' };
        return pushCommand('rename-frame', { frameId, name: name.slice(0, 80) });
      }
    },
    {
      name: 'whiteboard_bind_frame',
      description: 'Make an EXISTING frame the structural parent of all notes currently lying inside it (tldraw reparenting with coordinate conversion). After this, moving the frame moves its notes as one unit. Use when the human wants structural membership for an existing cluster. Only affects parenting of notes already inside the frame bounds — nothing is deleted.',
      parameters: {
        type: 'object',
        properties: {
          frameId: { type: 'string', description: 'Frame id of the existing frame (from whiteboard_state frames).' }
        },
        required: ['frameId']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        const frameId = args && args.frameId ? String(args.frameId) : '';
        if (!frameId) return { accepted: false, reason: 'frameId ist erforderlich' };
        return pushCommand('bind-frame', { frameId });
      }
    },
    {
      name: 'whiteboard_frame_to_back',
      description: 'Send an EXISTING frame to the back of the z-order so it can never cover its notes. Use this when a frame visually overlaps and hides the notes it should contain (the frame must sit BEHIND its content). Pass the frameId from whiteboard_state frames. This changes only layering — nothing is moved or deleted.',
      parameters: {
        type: 'object',
        properties: {
          frameId: { type: 'string', description: 'Frame id of the existing frame (from whiteboard_state frames).' }
        },
        required: ['frameId']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        const frameId = args && args.frameId ? String(args.frameId) : '';
        if (!frameId) return { accepted: false, reason: 'frameId ist erforderlich' };
        return pushCommand('frame-to-back', { frameId });
      }
    },
    {
      name: 'whiteboard_arrange_sequence',
      description: 'Arrange an ordered sequence of EXISTING notes into a tidy horizontal row inside a named frame (e.g. a workflow), recreate violet "dann" arrows BETWEEN THEM AS REAL BINDINGS (arrows follow the notes when they move), and wrap the row in a frame that sits BEHIND the notes and becomes their structural parent. Human notes keep their actor attribution but get meta.movedBy="agent". Items are given in order as {id} or {text} from whiteboard_state. Use only when the human asked for an arrangement — this MOVES notes (undoable, one tldraw history step).',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Notes in their intended order (left to right).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Note id (from whiteboard_state).' },
                text: { type: 'string', description: 'Exact note text (alternative to id).' }
              }
            }
          },
          frameName: { type: 'string', description: 'Name of the wrapping frame, e.g. "Phasen".' },
          x: { type: 'number', description: 'Optional left x of the row (default 80).' },
          y: { type: 'number', description: 'Optional top y of the row (default 80).' },
          step: { type: 'number', description: 'Optional horizontal spacing between notes (default 280).' }
        },
        required: ['items', 'frameName']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        const items = args && Array.isArray(args.items) ? args.items : [];
        if (items.length < 2) return { accepted: false, reason: 'mindestens zwei Zettel nötig' };
        const clean = [];
        for (let i = 0; i < items.length && i < 20; i++) {
          const it = items[i] || {};
          clean.push({ id: it.id ? String(it.id) : null, text: it.text ? String(it.text).slice(0, 200) : null });
        }
        return pushCommand('arrange-sequence', {
          items: clean,
          frameName: String((args && args.frameName) || 'Phasen').slice(0, 80),
          x: typeof (args && args.x) === 'number' ? args.x : null,
          y: typeof (args && args.y) === 'number' ? args.y : null,
          step: typeof (args && args.step) === 'number' ? args.step : null
        });
      }
    },
    {
      name: 'whiteboard_propose_clusters',
      description: 'Propose one or more clusters on the shared whiteboard. Each cluster draws a violet proposal frame (marked "🤖 Vorschlag:") around the referenced notes WITHOUT moving them — the proposal is non-binding and purely geometric. Re-invoking with the same cluster title REUSES the existing proposal frame. When the human clicks Übernehmen, the notes are reparented into the frame (structural membership); Verwerfen only deletes the frame. To RENAME a proposal, use whiteboard_rename_cluster instead.',
      parameters: {
        type: 'object',
        properties: {
          clusters: {
            type: 'array',
            description: 'One entry per proposed cluster.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Cluster title, e.g. "Orientierung".' },
                noteIds: { type: 'array', items: { type: 'string' }, description: 'Note ids (from whiteboard_state) that belong to this cluster.' },
                noteTexts: { type: 'array', items: { type: 'string' }, description: 'Exact note texts to match instead of / in addition to ids.' }
              },
              required: ['title']
            }
          }
        },
        required: ['clusters']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        const clusters = args && Array.isArray(args.clusters) ? args.clusters : [];
        if (!clusters.length) return { accepted: false, reason: 'clusters ist leer' };
        const clean = [];
        for (let i = 0; i < clusters.length && i < 12; i++) {
          const c = clusters[i] || {};
          clean.push({
            title: String(c.title || 'Cluster').slice(0, 80),
            noteIds: Array.isArray(c.noteIds) ? c.noteIds.map(String).slice(0, 50) : [],
            noteTexts: Array.isArray(c.noteTexts) ? c.noteTexts.map(function (t) { return String(t).slice(0, 200); }).slice(0, 50) : []
          });
        }
        return pushCommand('propose-clusters', { clusters: clean });
      }
    },
    {
      name: 'whiteboard_connect_notes',
      description: 'Propose a violet arrow connection between two notes. The arrow is created as a REAL BINDING (editor.createBindings): it stays attached and follows both notes when they move. Reference both notes by id and/or exact text.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'object', properties: { id: { type: 'string', description: 'Note id of the source.' }, text: { type: 'string', description: 'Exact text of the source note.' } }, description: 'Source note reference.' },
          to: { type: 'object', properties: { id: { type: 'string', description: 'Note id of the target.' }, text: { type: 'string', description: 'Exact text of the target note.' } }, description: 'Target note reference.' },
          label: { type: 'string', description: 'Optional short label for the arrow.' }
        },
        required: ['from', 'to']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        if (!args || !args.from || !args.to) return { accepted: false, reason: 'from/to fehlen' };
        return pushCommand('connect-notes', {
          from: { id: args.from.id ? String(args.from.id) : null, text: args.from.text ? String(args.from.text).slice(0, 200) : null },
          to: { id: args.to.id ? String(args.to.id) : null, text: args.to.text ? String(args.to.text).slice(0, 200) : null },
          label: args.label ? String(args.label).slice(0, 60) : null
        });
      }
    },
    {
      name: 'whiteboard_highlight_notes',
      description: 'Highlight one or more notes on the shared whiteboard by selecting them and zooming the view to them. Use to draw the human\'s attention to specific ideas without changing anything.',
      parameters: {
        type: 'object',
        properties: {
          noteIds: { type: 'array', items: { type: 'string' }, description: 'Note ids to highlight.' },
          noteTexts: { type: 'array', items: { type: 'string' }, description: 'Exact note texts to highlight.' }
        }
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        return pushCommand('highlight-notes', {
          noteIds: args && Array.isArray(args.noteIds) ? args.noteIds.map(String).slice(0, 50) : [],
          noteTexts: args && Array.isArray(args.noteTexts) ? args.noteTexts.map(function (t) { return String(t).slice(0, 200); }).slice(0, 50) : []
        });
      }
    },
    {
      name: 'whiteboard_render_plan',
      description: 'Execute one validated, generic semantic RenderPlan on the active shared tldraw board. This is an internal host-to-client seam for capabilities such as pages, frames, shape copies, links and assets; PTS or another domain layer owns semantic interpretation. The command is queued as one batch and does not write domain files.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', description: 'Must be render-plan.' },
          version: { type: 'string' },
          plan: { type: 'object' },
          roles: { type: 'object' },
          capabilities: { type: 'array', items: { type: 'string' } }
        },
        required: ['op', 'plan']
      },
      output: outputObject,
      execute: async function (args, exec) {
        captureSession(exec);
        if (!args || args.op !== 'render-plan' || !args.plan || typeof args.plan !== 'object') {
          return { accepted: false, reason: 'render-plan und plan sind erforderlich' };
        }
        return pushCommand('render-plan', { version: args.version || '1', plan: args.plan, roles: args.roles || {}, capabilities: Array.isArray(args.capabilities) ? args.capabilities.slice(0, 40) : [] });
      }
    }
  ];

  for (const tool of tools) {
    ctx.effect(() => toolsReg.register(tool), 'tool:' + tool.name);
  }

  console.log('[dsh-whiteboard] host half ready — route /dsh-whiteboard/api, tools: ' + tools.map(t => t.name).join(', '));
}

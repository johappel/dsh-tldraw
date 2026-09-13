// dsh-whiteboard — Client half (Classic Script, loaded via window.__ModuleLoader__)
// Target: DSH right-Sidebar architecture (ctx.sidebarRightTabs + the keyed
// `sidebar.right.pane.tab` seat). The legacy `conversation.view` / `details`
// seats of older DSH versions no longer exist and are not registered.
window.__ModuleLoader__.load({
  id: 'dsh-whiteboard',
  factory: function (require) {
    var React = require('react');

    var TL_VERSION = '5.4.2';
    var TYPE_ID = 'dsh-whiteboard';
    var TYPE_KIND = 'whiteboard';
    var OPEN_PREFERENCE_KEY = 'dsh-whiteboard:open-preference';
    var LAST_SESSION_KEY = 'dsh-whiteboard:last-session';
    var CSS_URLS = ['/dsh-whiteboard/tldraw.css'];
    var API_BASE = '/dsh-whiteboard/api';
    var OPEN_EVENTS_URL = '/dsh-whiteboard/open-events';
    var COMMAND_EVENTS_URL = '/dsh-whiteboard/command-events';

    var loadedModules = null;
    var modulesPromise = null;
    var editorHolder = { editor: null };
    var boardHost = null;
    var boardRoot = null;
    var boardKey = null;
    var boardSessionId = null;
    // Invalidate every in-flight asynchronous mount when the session or
    // persistence identity changes. A resolved dynamic import must never
    // mount an editor that belonged to an earlier sidebar lifecycle.
    var boardMountEpoch = 0;
    var requestedSessionId = null;
    var serverBoardId = null;
    var serverVersion = 0;
    var serverReady = false;
    var serverPersistenceEnabled = false;
    var serverRetryRequested = false;
    var migrateFromKey = null;
    var migrationLastKey = null;
    var migrationRunning = false;
    var panelOpenFlag = false;      // vom Menschen gesetzt; Standard: ausgeblendet
    var panelAutoUntil = 0;         // Auto-Einblendung nach Agentenänderungen
    var sidebarRef = { open: null };
    var uiState = { counts: { notes: 0, human: 0, agent: 0, proposals: 0 }, notes: [], proposals: [], selection: [], activity: [], phase: 'loading', error: '' };
    var uiSubs = [];

    var clientCtx = { timeout: function (fn, ms) { return setTimeout(fn, ms); } };
    var commandConsumer = null;
    // The host removes queued commands when the command EventSource connects.
    // tldraw/React modules load asynchronously, so an event can arrive before
    // the editor-side consumer exists. Retain it until the consumer is ready.
    var deferredCommandEvents = [];
    var completedCommandIds = Object.create(null);

    function readLocalStorage(key) {
      try { return window.localStorage.getItem(key); } catch (err) { return null; }
    }

    function writeLocalStorage(key, value) {
      try { window.localStorage.setItem(key, String(value)); } catch (err) {}
    }

    function removeLocalStorage(key) {
      try { window.localStorage.removeItem(key); } catch (err) {}
    }

    function rememberBoardOpen() { writeLocalStorage(OPEN_PREFERENCE_KEY, '1'); }
    function rememberBoardClosed() { removeLocalStorage(OPEN_PREFERENCE_KEY); }
    function rememberSession(sessionId) { if (sessionId) writeLocalStorage(LAST_SESSION_KEY, String(sessionId)); }

    function isRetryableNetworkError(error) {
      var message = String(error && error.message || error || '');
      return error instanceof TypeError || /NetworkError|Failed to fetch|Load failed|network request failed/i.test(message);
    }

    function apiCall(method, args) {
      var retries = 0;
      function request() {
        return fetch(API_BASE, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ method: method, args: args || {} })
        }).then(function (r) {
          return r.text().then(function (text) {
            var value = null;
            try { value = text ? JSON.parse(text) : {}; } catch (parseError) {
              throw new Error('Whiteboard-API liefert ungültiges JSON (HTTP ' + r.status + ')');
            }
            if (!r.ok) throw new Error(value && value.error || 'Whiteboard-API HTTP ' + r.status);
            return value;
          });
        }).catch(function (error) {
          // A reload or a short DSH route restart can abort one request. Retry
          // once, but never create an idle request loop for a broken route.
          if (retries < 1 && isRetryableNetworkError(error)) {
            retries++;
            return new Promise(function (resolve) { clientCtx.timeout(resolve, 250); }).then(request);
          }
          throw error;
        });
      }
      return request();
    }

    function retryDelay(attempt) {
      return new Promise(function (resolve) {
        clientCtx.timeout(resolve, Math.min(750, 150 + attempt * 100));
      });
    }

    // During a DSH reload the session registry and the web route do not become
    // available at exactly the same time. Retry only the active board lookup;
    // this is not an idle poll and it never selects a fallback workspace.
    function boardApiCall(sessionId, attempts) {
      var attempt = attempts || 0;
      return apiCall('wb-board', { sessionId: sessionId }).then(function (remote) {
        if (remote && remote.ok === true && remote.boardId) return remote;
        if (attempt < 10 && remote && remote.ok === false && /Session|Workspace|Whiteboard/i.test(String(remote.error || ''))) {
          return retryDelay(attempt).then(function () { return boardApiCall(sessionId, attempt + 1); });
        }
        throw new Error(remote && remote.error || 'Whiteboard-Workspace konnte nicht aufgelöst werden');
      }).catch(function (error) {
        var message = String(error && error.message || error || '');
        if (attempt < 10 && /HTTP (401|404|408|425|429|500|502|503|504)|NetworkError|Failed to fetch|Load failed|network request failed/i.test(message)) {
          return retryDelay(attempt).then(function () { return boardApiCall(sessionId, attempt + 1); });
        }
        throw error;
      });
    }

    function activeSessionId() {
      return boardSessionId;
    }

    function getTldrawSnapshot(mods, editor) {
      if (mods && mods.tldraw && typeof mods.tldraw.getSnapshot === 'function') return mods.tldraw.getSnapshot(editor.store);
      if (editor && editor.store && typeof editor.store.getSnapshot === 'function') return editor.store.getSnapshot();
      throw new Error('tldraw Snapshot-API nicht verfügbar');
    }

    function snapshotHasContent(snapshot) {
      var stores = [];
      if (snapshot && snapshot.store && typeof snapshot.store === 'object') stores.push(snapshot.store);
      if (snapshot && snapshot.document && snapshot.document.store && typeof snapshot.document.store === 'object') stores.push(snapshot.document.store);
      for (var s = 0; s < stores.length; s++) {
        var store = stores[s];
        var records = Array.isArray(store.records) ? store.records : Object.keys(store).map(function (key) { return store[key]; });
        for (var i = 0; i < records.length; i++) {
          if (records[i] && (records[i].typeName === 'shape' || records[i].typeName === 'binding' || String(records[i].id || '').indexOf('shape:') === 0)) return true;
        }
      }
      return false;
    }

    function resolveBoardIdentity(sessionId) {
      if (!sessionId) return Promise.reject(new Error('Whiteboard-Session fehlt'));
      return boardApiCall(sessionId).then(function (remote) {
        if (!/^workspace-[a-f0-9]{32}$/.test(String(remote.boardId || ''))) {
          throw new Error('Whiteboard-Workspace konnte nicht aufgelöst werden');
        }
        return {
          boardId: String(remote.boardId),
          persistenceKey: 'dsh-whiteboard-board-' + String(remote.boardId)
        };
      });
    }

    function dedupeRendererSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return { snapshot: snapshot, removed: 0 };
      var copy;
      try { copy = JSON.parse(JSON.stringify(snapshot)); } catch (error) { return { snapshot: snapshot, removed: 0 }; }
      var store = copy && copy.document && copy.document.store;
      if (!store || typeof store !== 'object' || Array.isArray(store)) return { snapshot: copy, removed: 0 };
      var records = Object.keys(store).map(function (key) { return store[key]; }).filter(Boolean);
      var byRenderKey = {};
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.typeName !== 'shape' || !record.meta || record.meta.actor !== 'agent' || !record.meta.renderKey) continue;
        var key = String(record.meta.renderKey);
        if (!byRenderKey[key]) byRenderKey[key] = [];
        byRenderKey[key].push(record);
      }
      var removedIds = Object.create(null);
      Object.keys(byRenderKey).forEach(function (key) {
        var group = byRenderKey[key].slice().sort(function (a, b) {
          return Number(a.meta && a.meta.at || 0) - Number(b.meta && b.meta.at || 0);
        });
        for (var n = 0; n < group.length - 1; n++) removedIds[group[n].id] = true;
      });
      // A frame deletion cascades in tldraw. Remove a duplicate frame only
      // when all of its children are renderer-owned; remove those children in
      // the same normalization pass. A human/unknown child keeps its frame.
      for (var r = 0; r < records.length; r++) {
        var frame = records[r];
        if (!removedIds[frame.id] || frame.type !== 'frame') continue;
        var rendererChildren = [];
        var safe = true;
        for (var c = 0; c < records.length; c++) {
          if (records[c].parentId !== frame.id) continue;
          var childMeta = records[c].meta || {};
          if (records[c].typeName !== 'shape' || childMeta.actor !== 'agent' || String(childMeta.renderKey || '').indexOf('renderer:') !== 0) {
            safe = false;
            break;
          }
          rendererChildren.push(records[c].id);
        }
        if (!safe) delete removedIds[frame.id];
        else for (var rc = 0; rc < rendererChildren.length; rc++) removedIds[rendererChildren[rc]] = true;
      }
      var removed = 0;
      Object.keys(removedIds).forEach(function (id) {
        if (store[id]) { delete store[id]; removed++; }
      });
      if (removed) {
        Object.keys(store).forEach(function (id) {
          var record = store[id];
          if (record && record.typeName === 'binding' && (removedIds[record.fromId] || removedIds[record.toId])) delete store[id];
        });
      }
      return { snapshot: copy, removed: removed };
    }

    function allDocumentShapes(editor) {
      try {
        if (editor && editor.store && typeof editor.store.allRecords === 'function') {
          return (editor.store.allRecords() || []).filter(function (record) { return record && record.typeName === 'shape'; });
        }
      } catch (error) {}
      try { return editor && typeof editor.getCurrentPageShapes === 'function' ? editor.getCurrentPageShapes() || [] : []; } catch (error2) { return []; }
    }

    function hydrateFromServer(editor, mods) {
      serverReady = false;
      serverPersistenceEnabled = false;
      serverRetryRequested = false;
      return boardApiCall(activeSessionId()).then(function (remote) {
        serverBoardId = String(remote.boardId);
        serverVersion = Number.isInteger(remote.version) && remote.version >= 0 ? remote.version : 0;
        var localSnapshot = getTldrawSnapshot(mods, editor);
        var normalized = dedupeRendererSnapshot(remote.snapshot);
        var remoteSnapshot = normalized.snapshot;
        if (normalized.removed) pushActivity('🧹 ' + normalized.removed + ' alte Renderer-Duplikate bereinigt');
        if (snapshotHasContent(remoteSnapshot)) {
          var loaded = mods.tldraw.loadSnapshot(editor.store, remoteSnapshot);
          return Promise.resolve(loaded).then(function () {
            pushActivity('☁️ Whiteboard-Stand aus dem DSH-Store geladen');
          });
        }
        if (snapshotHasContent(localSnapshot)) {
          return apiCall('wb-save', { boardId: serverBoardId, sessionId: activeSessionId(), expectedVersion: serverVersion, snapshot: localSnapshot }).then(function (saved) {
            if (!saved || saved.ok !== true) throw new Error(saved && saved.conflict ? 'Konflikt beim ersten Whiteboard-Speichern' : 'Whiteboard-Stand konnte nicht gespeichert werden');
            serverVersion = saved.version;
            pushActivity('☁️ vorhandenen lokalen Whiteboard-Stand gespeichert');
          });
        }
        return null;
      }).then(function () {
        serverReady = true;
        serverPersistenceEnabled = true;
      }).catch(function (error) {
        serverReady = false;
        serverPersistenceEnabled = false;
        pushUi({ phase: 'error', error: 'Server-Persistenz nicht verfügbar: ' + truncate(error && error.message || error, 120) });
        pushActivity('⚠️ Server-Persistenz nicht verfügbar: ' + truncate(error && error.message || error, 120));
        console.error('[dsh-whiteboard] server snapshot load failed', error);
      });
    }

    function persistToServer(editor, mods, snapshot) {
      if (!serverPersistenceEnabled || !serverBoardId) return Promise.resolve();
      var fullSnapshot;
      try { fullSnapshot = getTldrawSnapshot(mods, editor); } catch (error) {
        serverRetryRequested = true;
        return Promise.reject(error);
      }
      return apiCall('wb-save', {
        boardId: serverBoardId,
        sessionId: activeSessionId(),
        expectedVersion: serverVersion,
        snapshot: fullSnapshot
      }).then(function (saved) {
        if (saved && saved.ok === true) {
          serverVersion = saved.version;
          return;
        }
        if (saved && saved.conflict) {
          serverPersistenceEnabled = false;
          serverRetryRequested = false;
          pushActivity('⚠️ Whiteboard-Konflikt: anderer Browser-Stand geschützt; Seite bitte neu laden');
          return;
        }
        serverRetryRequested = true;
        throw new Error(saved && saved.error || 'Whiteboard-Snapshot konnte nicht gespeichert werden');
      }).catch(function (error) {
        if (serverPersistenceEnabled) serverRetryRequested = true;
        pushActivity('⚠️ Whiteboard-Speicherung fehlgeschlagen: ' + truncate(error && error.message || error, 120));
        console.error('[dsh-whiteboard] server snapshot save failed', error);
      });
    }

    function insertStyles(css) {
      var tag = document.createElement('style');
      tag.id = 'dsh-whiteboard-styles';
      tag.textContent = css;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    function pushUi(patch) {
      if (patch) {
        for (var k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) uiState[k] = patch[k]; }
      }
      for (var i = 0; i < uiSubs.length; i++) {
        try { uiSubs[i](); } catch (err) {}
      }
    }

    function pushActivity(text) {
      pushUi({ activity: [text].concat(uiState.activity).slice(0, 8) });
    }

    /** Beiträge-Panel kurz einblenden (z. B. nach einer Agentenänderung am Board). */
    function showPanelBriefly(ms) {
      var span = ms || 5000;
      panelAutoUntil = Date.now() + span;
      pushUi();
      clientCtx.timeout(function () { pushUi(); }, span + 150);
    }

    function panelIsVisible() {
      return panelOpenFlag || Date.now() < panelAutoUntil;
    }

    function loadModules() {
      if (modulesPromise) return modulesPromise;
      var importFn = new Function('u', 'return' + ' import(u)');
      function importWithTimeout(url, timeoutMs) {
        return Promise.race([
          importFn(url),
          new Promise(function (_, reject) {
            clientCtx.timeout(function () { reject(new Error('Whiteboard-Runtime hat nicht innerhalb von ' + Math.round(timeoutMs / 1000) + ' Sekunden geladen')); }, timeoutMs);
          })
        ]);
      }
      modulesPromise = importWithTimeout('/dsh-whiteboard/runtime.mjs', 12000).then(function (mods) {
        if (!mods || !mods.react || !mods.reactDomClient || !mods.tldraw) throw new Error('Lokale Whiteboard-Runtime ist unvollständig');
        loadedModules = { react: mods.react, reactDomClient: mods.reactDomClient, tldraw: mods.tldraw };
        return loadedModules;
      }).catch(function (err) {
        modulesPromise = null;
        loadedModules = null;
        throw err;
      });
      return modulesPromise;
    }

    function resetMountedBoard() {
      boardMountEpoch += 1;
      try { if (boardRoot) boardRoot.unmount(); } catch (err) {}
      boardRoot = null;
      editorHolder.editor = null;
      boardKey = null;
      boardSessionId = null;
      serverBoardId = null;
      serverVersion = 0;
      serverReady = false;
      serverPersistenceEnabled = false;
      serverRetryRequested = false;
      migrateFromKey = null;
      migrationLastKey = null;
      migrationRunning = false;
      uiState = { counts: { notes: 0, human: 0, agent: 0, proposals: 0 }, notes: [], proposals: [], selection: [], activity: [], phase: 'loading', error: '' };
      pushUi();
    }

    // tldraw must never mount into a 0-px / display:none container: its text
    // measurement throws (`measureElementTextNodeSpans`) as soon as geometry is
    // computed. Wait until the seat is really laid out.
    function initBoardWhenVisible(getContainer, persistenceKey, sessionId, attempts) {
      var tries = attempts || 0;
      var el = getContainer();
      var ready = el && (function () {
        var r = el.getBoundingClientRect();
        return r.width >= 80 && r.height >= 80;
      })();
      if (!ready) {
        if (tries < 200) {
          clientCtx.timeout(function () { initBoardWhenVisible(getContainer, persistenceKey, sessionId, tries + 1); }, 120);
        } else if (requestedSessionId === sessionId && !boardRoot && !editorHolder.editor) {
          // A hidden or zero-sized sidebar seat cannot safely host tldraw.
          // Do not leave the person with a permanent loader: retain the
          // fail-closed identity and offer the existing explicit retry.
          pushUi({ phase: 'error', error: 'Das Whiteboard-Panel hat nach dem Reload keine nutzbare Größe. Bitte Panel erneut öffnen oder „Erneut versuchen“ wählen.' });
          console.error('[dsh-whiteboard] board mount timed out waiting for a visible container', { sessionId: sessionId, attempts: tries });
        }
        return;
      }
      if (requestedSessionId !== sessionId) return;
      if (boardRoot || editorHolder.editor) return;
      // The identity is reserved before the asynchronous runtime import. This
      // stops two effects for the same sidebar session from creating two React
      // roots in the single global host while the import is still pending.
      if (boardSessionId === sessionId && boardKey === persistenceKey) return;
      var mountEpoch = ++boardMountEpoch;
      boardKey = persistenceKey;
      boardSessionId = sessionId;
      loadModules().then(function (mods) {
        if (mountEpoch !== boardMountEpoch || requestedSessionId !== sessionId || boardSessionId !== sessionId || boardKey !== persistenceKey) return;
        boardRoot = mods.reactDomClient.createRoot(boardHost);
        boardRoot.render(mods.react.createElement(mods.tldraw.Tldraw, {
          persistenceKey: persistenceKey,
          inferDarkMode: true,
          onMount: function (editor) {
            if (mountEpoch !== boardMountEpoch || requestedSessionId !== sessionId) return;
            editorHolder.editor = editor;
            hydrateFromServer(editor, loadedModules).then(function () {
              if (commandConsumer) commandConsumer([], true);
              // User edits are the only reason for a new snapshot. This
              // replaces the former fixed-interval snapshot poll.
              if (editor.store && typeof editor.store.listen === 'function') {
                // Persist every tldraw mutation, including shapes that are not
                // part of the compact Companion projection (for example a
                // plain text shape or a geo heart). The full snapshot remains
                // the durable source; the compact summary is still unchanged.
                editor.store.listen(function () { if (commandConsumer) commandConsumer([], true); });
              }
            });
            navigateHash(editor);
            pushUi({ phase: 'ready' });
          }
        }));
      }).catch(function (err) {
        if (mountEpoch !== boardMountEpoch || requestedSessionId !== sessionId) return;
        boardKey = null;
        boardSessionId = null;
        pushUi({ phase: 'error', error: String((err && err.message) || err) });
      });
    }

    function runMigration(mainEditor, oldKey) {
      return new Promise(function (resolve) {
        pushActivity('🧑 Migration: prüfe alten Stand (' + truncate(oldKey, 44) + ')');
        var holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;';
        document.body.appendChild(holder);
        loadModules().then(function (mods) {
          var root = mods.reactDomClient.createRoot(holder);
          var done = false;
          root.render(mods.react.createElement(mods.tldraw.Tldraw, {
            persistenceKey: oldKey,
            inferDarkMode: true,
            onMount: function (oldEditor) {
              var attempts = 0;
              function finish() {
                if (done) return;
                done = true;
                try { root.unmount(); } catch (e2) {}
                try { holder.remove(); } catch (e3) {}
                resolve();
              }
              function grab() {
                if (done) return;
                try {
                  var snap = null;
                  if (typeof mods.tldraw.getSnapshot === 'function') snap = mods.tldraw.getSnapshot(oldEditor.store);
                  if (!snap && typeof oldEditor.store.getSnapshot === 'function') snap = oldEditor.store.getSnapshot();
                  if (!snap) throw new Error('keine Snapshot-API gefunden');
                  var oldRecords = (snap && snap.store && snap.store.records) || [];
                  var contentCount = 0;
                  for (var i = 0; i < oldRecords.length; i++) {
                    var tn0 = oldRecords[i] && oldRecords[i].typeName;
                    if (tn0 === 'shape' || tn0 === 'binding') contentCount++;
                  }
                  if (!contentCount && attempts < 3) { attempts++; clientCtx.timeout(grab, 1200); return; }
                  if (!contentCount) {
                    pushActivity('⚠️ Migration: Schlüssel ist leer — kein alter Stand gefunden');
                    finish();
                    return;
                  }
                  var curRecords = [];
                  try {
                    var cur = null;
                    if (typeof mods.tldraw.getSnapshot === 'function') cur = mods.tldraw.getSnapshot(mainEditor.store);
                    if (!cur && typeof mainEditor.store.getSnapshot === 'function') cur = mainEditor.store.getSnapshot();
                    if (cur && cur.store && cur.store.records) curRecords = cur.store.records;
                  } catch (e6) {}
                  var curIds = {};
                  for (var c = 0; c < curRecords.length; c++) curIds[curRecords[c].id] = true;
                  var merged = curRecords.slice();
                  var added = 0;
                  for (var j = 0; j < oldRecords.length; j++) {
                    var rec = oldRecords[j];
                    if (!rec) continue;
                    var tn = rec.typeName;
                    if (tn !== 'shape' && tn !== 'binding' && tn !== 'page' && tn !== 'asset') continue;
                    if (curIds[rec.id]) continue;
                    merged.push(rec);
                    added++;
                  }
                  snap.store.records = merged;
                  var res = mods.tldraw.loadSnapshot(mainEditor.store, snap);
                  var report = function () { pushActivity('🧑 Migration: alter Stand übernommen (' + added + ' Einträge)'); };
                  if (res && typeof res.then === 'function') {
                    res.then(function () { report(); finish(); }, function (e) { pushActivity('⚠️ Migration fehlgeschlagen: ' + String(e && e.message || e)); finish(); });
                  } else { report(); finish(); }
                } catch (e) {
                  pushActivity('⚠️ Migration fehlgeschlagen: ' + String(e && e.message || e));
                  finish();
                }
              }
              clientCtx.timeout(grab, 1000);
            }
          }));
        }).catch(function (err) {
          pushActivity('⚠️ Migration fehlgeschlagen: ' + String(err && err.message || err));
          try { holder.remove(); } catch (e4) {}
          resolve();
        });
      });
    }

    function toRichText(text, href) {
      var textNode = { type: 'text', text: String(text) };
      if (href) textNode.marks = [{ type: 'link', attrs: { href: String(href) } }];
      return { type: 'doc', content: [{ type: 'paragraph', content: [textNode] }] };
    }

    function propsToText(props) {
      if (!props) return '';
      if (typeof props.text === 'string' && props.text) return props.text;
      var rt = props.richText;
      if (!rt) return '';
      var out = [];
      function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (typeof node.text === 'string') out.push(node.text);
        if (Array.isArray(node.content)) { for (var i = 0; i < node.content.length; i++) walk(node.content[i]); }
        if (node.type === 'paragraph') out.push('\n');
      }
      if (Array.isArray(rt.content)) { for (var j = 0; j < rt.content.length; j++) walk(rt.content[j]); }
      return out.join('').trim();
    }

    function uniqueShapeId(mods) {
      if (mods && mods.tldraw && typeof mods.tldraw.createShapeId === 'function') return mods.tldraw.createShapeId();
      return 'shape:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function createArrowBindings(editor, arrowId, fromShapeId, toShapeId) {
      var terminals = [
        { fromId: arrowId, toId: fromShapeId, type: 'arrow', props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } },
        { fromId: arrowId, toId: toShapeId, type: 'arrow', props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } }
      ];
      var created = false;
      if (typeof editor.createBindings === 'function') { editor.createBindings(terminals); created = true; }
      else if (typeof editor.createBinding === 'function') { editor.createBinding(terminals[0]); editor.createBinding(terminals[1]); created = true; }
      if (!created) { pushActivity('⚠️ Pfeil-Bindung nicht verfügbar — createBindings fehlt'); return false; }
      if (countBindingsFor(editor, arrowId) === 0) pushActivity('⚠️ Pfeil-Bindung wurde nicht angelegt (0 Bindings am Pfeil)');
      return true;
    }

    /** Bindings eines Shapes zählen — über die API und, falls die fehlt, über den Store. */
    function countBindingsFor(editor, shapeId) {
      try {
        if (typeof editor.getBindingsFromShape === 'function') {
          var direct = editor.getBindingsFromShape(shapeId);
          if (direct && direct.length) return direct.length;
        }
      } catch (e) {}
      try {
        var store = editor.store;
        var recs = null;
        if (store && typeof store.allRecords === 'function') recs = store.allRecords();
        else if (store && store.query && typeof store.query.records === 'function') {
          var q = store.query.records('binding');
          recs = q && typeof q.get === 'function' ? q.get() : q;
        }
        if (recs) {
          var n = 0;
          for (var i = 0; i < recs.length; i++) {
            var r = recs[i];
            if (r && r.typeName === 'binding' && r.fromId === shapeId) n++;
          }
          return n;
        }
      } catch (e2) {}
      return 0;
    }

    function truncate(text, max) {
      var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      return t.length > max ? t.slice(0, max - 1) + '…' : t;
    }

    function normalizeShapeId(id) {
      var s = String(id);
      return s.indexOf(':') >= 0 ? s : 'shape:' + s;
    }

    function findFreeSpot(editor) {
      var boxes = [];
      var shapes = editor.getCurrentPageShapes();
      for (var i = 0; i < shapes.length; i++) {
        var s = shapes[i];
        if (s.type !== 'note' && s.type !== 'frame') continue;
        var b = editor.getShapePageBounds(s.id);
        if (b) boxes.push({ x: b.x, y: b.y, w: b.w, h: b.h });
      }
      for (var row = 0; row < 60; row++) {
        for (var col = 0; col < 10; col++) {
          var x = 80 + col * 270;
          var y = 80 + row * 250;
          var clash = false;
          for (var j = 0; j < boxes.length; j++) {
            var bx = boxes[j];
            if (x < bx.x + bx.w + 20 && x + 250 > bx.x - 20 && y < bx.y + bx.h + 20 && y + 230 > bx.y - 20) { clash = true; break; }
          }
          if (!clash) return { x: x, y: y };
        }
      }
      return { x: 80, y: 80 };
    }

    function resolveNote(editor, ref) {
      if (!ref) return null;
      if (ref.id) {
        try {
          var s = editor.getShape(normalizeShapeId(ref.id));
          if (s && s.type === 'note') return s;
        } catch (err) {}
      }
      if (ref.text != null && String(ref.text).trim() !== '') {
        var needle = String(ref.text).trim().toLowerCase();
        var shapes = editor.getCurrentPageShapes();
        for (var i = 0; i < shapes.length; i++) {
          var sh = shapes[i];
          if (sh.type !== 'note') continue;
          if (propsToText(sh.props).trim().toLowerCase() === needle) return sh;
        }
      }
      return null;
    }

    // Host snapshots and the active tldraw editor can be one poll apart. Keep
    // the semantic text alongside a host-resolved id and fail closed before
    // entering editor.run when neither reference resolves. This avoids turning
    // an ordinary stale-reference race into tldraw's fatal transaction overlay.
    function resolveRenderShape(editor, element) {
      var ref = element && element.ref;
      var shape = null;
      if (ref && ref.id) {
        try { shape = editor.getShape(normalizeShapeId(ref.id)); } catch (err) {}
      }
      if (!shape && ref && ref.text != null) {
        var needle = String(ref.text).trim().toLowerCase();
          var shapes = editor.getCurrentPageShapes ? editor.getCurrentPageShapes() : [];
          for (var i = 0; i < shapes.length; i++) {
            var candidate = shapes[i];
          var candidateText = propsToText(candidate.props);
          if (!candidateText && candidate.type === 'frame') candidateText = (candidate.props && candidate.props.name) || '';
          if (!candidateText && candidate.type === 'geo') candidateText = (candidate.props && candidate.props.geo) || '';
          if (String(candidateText).trim().toLowerCase() === needle) {
            if (shape) throw new Error('mehrdeutige bestehende Render-Referenz: ' + ref.text);
            shape = candidate;
          }
        }
      }
      return shape;
    }

    function validateRenderSources(editor, plan) {
      var elements = Array.isArray(plan && plan.elements) ? plan.elements : [];
      for (var i = 0; i < elements.length; i++) {
        if (elements[i].source !== 'existing') continue;
        if (!resolveRenderShape(editor, elements[i])) {
          throw new Error('bestehendes Element nicht gefunden: ' + (elements[i].ref && (elements[i].ref.id || elements[i].ref.text) || 'unbekannte Referenz'));
        }
      }
    }

    function boundsUnion(editor, shapes) {
      var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (var i = 0; i < shapes.length; i++) {
        var b = editor.getShapePageBounds(shapes[i].id);
        if (!b) continue;
        if (b.x < x1) x1 = b.x;
        if (b.y < y1) y1 = b.y;
        if (b.x + b.w > x2) x2 = b.x + b.w;
        if (b.y + b.h > y2) y2 = b.y + b.h;
      }
      if (x1 === Infinity) return { x: 0, y: 0, w: 200, h: 200 };
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    function centerOf(editor, shapeId) {
      var b = editor.getShapePageBounds(shapeId);
      if (!b) return null;
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }

    function reparentNotesIntoFrame(editor, frame, notes) {
      var count = 0;
      for (var i = 0; i < notes.length; i++) {
        var s = notes[i];
        if (!s || s.id === frame.id) continue;
        var fresh = null;
        try { fresh = editor.getShape(s.id); } catch (err) {}
        if (!fresh) fresh = s;
        editor.updateShapes([{
          id: s.id, type: 'note', parentId: frame.id,
          x: fresh.x - frame.x, y: fresh.y - frame.y,
          meta: Object.assign({}, fresh.meta, { adoptedAt: Date.now() })
        }]);
        count++;
      }
      return count;
    }

    function readSelection(editor) {
      try {
        if (typeof editor.getSelectedShapeIds !== 'function') return [];
        var ids = editor.getSelectedShapeIds() || [];
        var out = [];
        for (var i = 0; i < ids.length && i < 50; i++) {
          var id = String(ids[i]);
          var s = null;
          try { s = editor.getShape(id); } catch (err) {}
          if (!s) { out.push({ id: id, kind: 'unknown', text: '' }); continue; }
          var selectionText = s.type === 'frame'
            ? ((s.props && s.props.name) || '')
            : propsToText(s.props);
          if (!selectionText && s.type === 'geo' && s.props && s.props.geo) selectionText = String(s.props.geo);
          if (!selectionText && s.type === 'image' && s.props && s.props.altText) selectionText = String(s.props.altText);
          out.push({ id: s.id, kind: s.type, text: truncate(selectionText, 60) });
        }
        return out;
      } catch (err2) { return []; }
    }

    function readCurrentPage(editor) {
      try {
        var pageId = typeof editor.getCurrentPageId === 'function' ? editor.getCurrentPageId() : null;
        var name = null;
        try {
          if (pageId && typeof editor.getPage === 'function') {
            var pg = editor.getPage(pageId);
            name = pg && pg.name ? String(pg.name) : null;
          }
        } catch (err) {}
        var pageCount = 1;
        try { if (typeof editor.getPages === 'function') pageCount = (editor.getPages() || []).length; } catch (err2) {}
        return { id: pageId ? String(pageId) : null, name: name, pageCount: pageCount };
      } catch (err3) { return { id: null, name: null, pageCount: 1 }; }
    }

    // The generic client receives already-resolved presentation specifications.
    // Domain semantics and their translation live in the calling domain layer.
    function presentationStyle(spec, field) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error((field || 'presentation') + ' fehlt');
      var shape = String(spec.shape || 'note');
      var color = String(spec.color || '').trim();
      // Presentation labels are optional. They may aid a generic caller, but
      // must never be required merely to create a note: domain layers can
      // retain their internal role while keeping the visible text exact.
      var label = spec.label === undefined ? '' : String(spec.label).trim();
      var icon = spec.icon === undefined ? '' : String(spec.icon);
      var size = spec.size === undefined ? 'm' : String(spec.size);
      if ((shape !== 'note' && shape !== 'text') || !color || color.length > 40 || label.length > 120 || icon.length > 12 || ['s', 'm', 'l', 'xl'].indexOf(size) < 0) throw new Error((field || 'presentation') + ' ist ungültig');
      if (shape === 'text' && (label || icon)) throw new Error((field || 'presentation') + ' darf Text nicht praefixieren');
      return { role: spec.role ? String(spec.role).slice(0, 40) : null, shape: shape, color: color, icon: icon, label: label, size: size };
    }

    function pageByName(editor, name) {
      var pages = typeof editor.getPages === 'function' ? (editor.getPages() || []) : [];
      for (var i = 0; i < pages.length; i++) if (String(pages[i].name || '') === String(name)) return pages[i];
      return null;
    }

    function normalizePageId(pageId) {
      var value = String(pageId || '');
      return value && value.indexOf('page:') === 0 ? value : (value ? 'page:' + value : '');
    }

    function ensureRenderPage(editor, title) {
      var page = pageByName(editor, title);
      if (!page) {
        if (typeof editor.createPage !== 'function') throw new Error('Page-Erzeugung nicht verfügbar');
        page = editor.createPage({ name: title });
      }
      if (!page || !page.id || typeof editor.setCurrentPage !== 'function') throw new Error('Page-Wechsel nicht verfügbar');
      var pageId = normalizePageId(page.id);
      editor.setCurrentPage(pageId);
      return Object.assign({}, page, { id: pageId });
    }

    // Do not start a render transaction until the requested page is active.
    function waitForCurrentPage(editor, pageId, attempts) {
      var expected = String(pageId);
      var tries = attempts || 0;
      var current = null;
      try { current = typeof editor.getCurrentPageId === 'function' ? editor.getCurrentPageId() : null; } catch (err) {}
      if (current != null && normalizePageId(current) === expected) return Promise.resolve(true);
      if (tries >= 200) return Promise.reject(new Error('Page-Wechsel nicht bestätigt: ' + expected));
      return new Promise(function (resolve) { clientCtx.timeout(resolve, 25); })
        .then(function () { return waitForCurrentPage(editor, pageId, tries + 1); });
    }

    function waitForPageRecord(editor, pageId, attempts) {
      var expected = normalizePageId(pageId);
      var tries = attempts || 0;
      var page = null;
      try { page = typeof editor.getPage === 'function' ? editor.getPage(expected) : null; } catch (err) {}
      // Treat the public page list as authoritative during the short
      // publication window in which a newly created page becomes queryable.
      if (!page && typeof editor.getPages === 'function') {
        try {
          var pages = editor.getPages() || [];
          for (var i = 0; i < pages.length; i++) {
            if (pages[i] && normalizePageId(pages[i].id) === expected) { page = pages[i]; break; }
          }
        } catch (err2) {}
      }
      if (page) return Promise.resolve(page);
      if (tries >= 200) return Promise.reject(new Error('Page-Record nicht verfügbar: ' + expected));
      return new Promise(function (resolve) { clientCtx.timeout(resolve, 25); })
        .then(function () { return waitForPageRecord(editor, pageId, tries + 1); });
    }

    async function activatePage(editor, pageId) {
      var normalizedPageId = normalizePageId(pageId);
      if (!normalizedPageId || typeof editor.setCurrentPage !== 'function') throw new Error('Page-Wechsel nicht verfügbar');
      await waitForPageRecord(editor, normalizedPageId);
      editor.setCurrentPage(normalizedPageId);
      return waitForCurrentPage(editor, normalizedPageId);
    }

    function pageHash(pageId) { return '#dsh-whiteboard-page=' + encodeURIComponent(String(pageId)); }

    function navigateHash(editor) {
      try {
        var raw = window.location.hash || '';
        var match = /^#dsh-whiteboard-page=(.+)$/.exec(raw);
        if (!match || typeof editor.setCurrentPage !== 'function') return;
        var id = decodeURIComponent(match[1]);
        if (typeof editor.getPage === 'function' && editor.getPage(id)) editor.setCurrentPage(id);
      } catch (err) {}
    }

    // tldraw deliberately opens rich-text links in a new tab. Page references
    // are different: they are links into this very board, so opening a fresh
    // DSH document loses the current sidebar/tab state. Intercept only our
    // own page hashes and let ordinary/external links keep tldraw's behavior.
    function internalPageLink(href) {
      var raw = String(href || '');
      var hash = '';
      try {
        var parsed = new URL(raw, window.location.href);
        if (parsed.origin !== window.location.origin ||
            parsed.pathname !== window.location.pathname) return null;
        hash = parsed.hash;
        if (/^#dsh-whiteboard-page=/.test(hash)) return { kind: 'legacy-hash', value: hash };
      } catch (err) {
        if (/^#dsh-whiteboard-page=/.test(raw)) return { kind: 'legacy-hash', value: raw };
      }
      return null;
    }

    function anchorFromEvent(event) {
      var node = event && event.target;
      while (node && node !== boardHost) {
        if (String(node.nodeName || '').toLowerCase() === 'a') {
          return node;
        }
        node = node.parentNode;
      }
      return null;
    }

    function navigateInternalPageLink(link) {
      if (link.kind !== 'legacy-hash') return;
      if (window.location.hash === link.value) navigateHash(editorHolder.editor);
      else window.location.hash = link.value;
    }

    function handleInternalPagePointerDown(event) {
      if (event && event.button !== undefined && event.button !== 0) return;
      var anchor = anchorFromEvent(event);
      if (!anchor) return;
      var link = internalPageLink(anchor.getAttribute('href') || anchor.href);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      navigateInternalPageLink(link);
    }

    // Keyboard activation can still produce a click without pointerdown.
    function handleInternalPageClick(event) {
      var anchor = anchorFromEvent(event);
      if (!anchor) return;
      var link = internalPageLink(anchor.getAttribute('href') || anchor.href);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      navigateInternalPageLink(link);
    }

    function renderStyledNote(mods, styleSpec, text, x, y, key, extraMeta, href) {
      var style = presentationStyle(styleSpec, 'element.presentation');
      var meta = Object.assign({ actor: 'agent', actorLabel: 'DSH Whiteboard',
        presentationRole: style.role, renderKey: 'renderer:' + String(key), at: Date.now() }, extraMeta || {});
      var prefix = [style.icon, style.label].filter(Boolean).join(' ');
      var visibleText = prefix ? prefix + ': ' + String(text) : String(text);
      return { id: uniqueShapeId(mods), type: 'note', x: x, y: y,
        // Renderer-owned cards must not inherit whichever handwritten font the
        // user last selected. An explicit neutral face keeps generated work
        // visually coherent and its text metrics deterministic.
        props: { color: style.color, font: 'sans', richText: toRichText(visibleText, href) }, meta: meta };
    }

    function renderStyledText(mods, styleSpec, text, x, y, key, extraMeta, href) {
      var style = presentationStyle(styleSpec, 'element.presentation');
      if (style.shape !== 'text') throw new Error('element.presentation ist kein Freitext');
      var meta = Object.assign({ actor: 'agent', actorLabel: 'DSH Whiteboard',
        presentationRole: style.role, renderKey: 'renderer:' + String(key), at: Date.now() }, extraMeta || {});
      return { id: uniqueShapeId(mods), type: 'text', x: x, y: y,
        props: { color: style.color, font: 'sans', size: style.size, autoSize: true, richText: toRichText(String(text), href) }, meta: meta };
    }

    function pageReference(mods, styleSpec, title, href, x, y, key) {
      return renderStyledNote(mods, styleSpec, title, x, y, key, { href: href, pageRef: href }, href);
    }

    function semanticLinkRenderKey(link, index) {
      // Parallel links remain distinct; repeating the same plan keeps the key stable.
      return 'renderer:link:' + String(link && link.from || '') + '>' + String(link && link.to || '') + ':' + String(link && link.label || '') + ':' + String(index);
    }

    function shapeCopy(mods, source, styleSpec, x, y, key, textOverride) {
      // A resolved caller may deliberately provide the visible text for an
      // existing shape (for example a domain-owned legacy-label migration).
      // The generic board neither interprets nor invents that text.
      var text = textOverride === undefined ? propsToText(source.props) : String(textOverride);
      return renderStyledNote(mods, styleSpec, text, x, y, key, {
        sourceId: source.id, sourceText: text, sourceActor: source.meta && source.meta.actor || 'human'
      });
    }

    function imageShape(mods, editor, element, styleSpec, x, y, key) {
      if (!element.material || !element.material.href) throw new Error('Bildreferenz ohne sichere URL');
      if (typeof editor.createAssets !== 'function') throw new Error('tldraw Asset-Seam nicht verfügbar');
      var materialPath = String(element.material.path || '');
      var materialExt = materialPath.toLowerCase().split('.').pop();
      var materialMime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })[materialExt] || 'image/png';
      var assetId = (mods.tldraw && typeof mods.tldraw.createAssetId === 'function') ? mods.tldraw.createAssetId() : 'asset:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      var w = typeof element.material.w === 'number' ? element.material.w : 320;
      var h = typeof element.material.h === 'number' ? element.material.h : 220;
      editor.createAssets([{ id: assetId, typeName: 'asset', type: 'image', props: {
        name: element.material.label || element.material.path, src: element.material.href, w: w, h: h,
        mimeType: materialMime, isAnimated: false
      }, meta: {} }]);
      return { id: uniqueShapeId(mods), type: 'image', x: x, y: y,
        props: {
          assetId: assetId, w: w, h: h, playing: true, url: '', crop: null,
          flipX: false, flipY: false, altText: element.material.label || element.material.path
        }, meta: {
          actor: 'agent', actorLabel: 'DSH Whiteboard', presentationRole: presentationStyle(styleSpec, 'element.presentation').role,
          renderKey: 'renderer:' + String(key), sourcePath: element.material.path
        } };
    }

    function reparentRenderedShapesIntoFrame(editor, frame, shapes) {
      for (var i = 0; i < shapes.length; i++) {
        var candidate = shapes[i];
        if (!candidate || candidate.id === frame.id) continue;
        var fresh = null;
        try { fresh = editor.getShape(candidate.id); } catch (err) {}
        if (!fresh || fresh.type === 'frame') continue;
        editor.updateShapes([{
          id: fresh.id, type: fresh.type, parentId: frame.id,
          x: fresh.x - frame.x, y: fresh.y - frame.y,
          meta: Object.assign({}, fresh.meta)
        }]);
      }
    }

    async function renderSemanticPlan(mods, editor, plan) {
      if (!plan || !plan.operation) throw new Error('RenderPlan fehlt');
      var sourceShapes = {};
      var elements = Array.isArray(plan.elements) ? plan.elements : [];
      for (var i = 0; i < elements.length; i++) {
        if (elements[i].source !== 'existing') continue;
        var existing = resolveRenderShape(editor, elements[i]);
        if (!existing) throw new Error('bestehendes Element nicht gefunden: ' + (elements[i].ref && (elements[i].ref.id || elements[i].ref.text)));
        sourceShapes[elements[i].key] = existing;
      }
      var sourcePage = readCurrentPage(editor);
      var sourceAnchor = plan.overview && plan.overview.sourceRef ? sourceShapes[plan.overview.sourceRef] : null;
      var sourceBounds = sourceAnchor ? editor.getShapePageBounds(sourceAnchor.id) : null;
      // Resolve and activate the target before entering the mutation batch so
      // page switching stays independent of the following shape writes.
      var targetPage;
      if (plan.page.action === 'use_current') {
        targetPage = editor.getPage(editor.getCurrentPageId());
      } else {
        targetPage = pageByName(editor, plan.page.title);
        if (!targetPage) {
          if (typeof editor.createPage !== 'function') throw new Error('Page-Erzeugung nicht verfügbar');
          targetPage = editor.createPage({ name: plan.page.title });
          // createPage's return value is not a stable PageRecord in the
          // loaded tldraw build. Resolve the created page by its exact name
          // through the public page list before using its typed id.
          var pageWait = 0;
          targetPage = null;
          while (!targetPage && pageWait < 200) {
            targetPage = pageByName(editor, plan.page.title);
            if (targetPage) break;
            await new Promise(function (resolve) { clientCtx.timeout(resolve, 25); });
            pageWait++;
          }
          if (targetPage && targetPage.id) targetPage = Object.assign({}, targetPage, { id: normalizePageId(targetPage.id) });
        }
        if (!targetPage || !targetPage.id || typeof editor.setCurrentPage !== 'function') throw new Error('Page-Wechsel nicht verfügbar');
        await activatePage(editor, targetPage.id);
      }
      if (!targetPage) throw new Error('Ziel-Page nicht auflösbar');
      // Use the complete document for renderer-owned cleanup. A workspace
      // board can be opened by multiple sessions and pages; limiting cleanup
      // to the active page leaves old generated copies behind.
      var all = allDocumentShapes(editor);
      var samePage = normalizePageId(sourcePage.id) === normalizePageId(targetPage.id);
      var detach = Array.isArray(plan.detach) ? plan.detach : [];
      var detachIds = [];
      function addDetachId(id) {
        if (!id || detachIds.indexOf(id) >= 0) return;
        detachIds.push(id);
      }
      for (var di = 0; di < detach.length; di++) {
        var match = String(detach[di].match || '').toLowerCase();
        var presentationRole = String(detach[di].presentationRole || '');
        for (var si = 0; si < all.length; si++) {
          var sm = all[si].meta || {};
          // sourceText identifies copied human content; renderer-created
          // notes have no sourceText, so use their visible text as the safe
          // fallback. Agent ownership and presentationRole still scope the
          // deletion to the caller's explicit semantic replacement.
          var candidateText = String(sm.sourceText || propsToText(all[si].props) || '').toLowerCase();
          if (sm.actor === 'agent' && sm.presentationRole === presentationRole && candidateText === match) addDetachId(all[si].id);
        }
      }
      var created = [];
      var byKey = {};
      // Only agent-owned shapes with a deterministic renderKey are replaced.
      // Human shapes are never removed based on their type, text, or position.
      var renderKeys = { 'renderer:workspace-heading': true, 'renderer:back-reference': true };
      for (var rk = 0; rk < elements.length; rk++) renderKeys['renderer:' + String(elements[rk].key)] = true;
      if (plan.overview && plan.overview.action === 'ensure_navigation_reference' && !samePage) renderKeys['renderer:overview-reference'] = true;
      var plannedLinks = Array.isArray(plan.links) ? plan.links : [];
      for (var lrk = 0; lrk < plannedLinks.length; lrk++) renderKeys[semanticLinkRenderKey(plannedLinks[lrk], lrk)] = true;
      for (var oldIndex = 0; oldIndex < all.length; oldIndex++) {
        var oldMeta = all[oldIndex].meta || {};
        if (oldMeta.actor === 'agent' && renderKeys[oldMeta.renderKey]) addDetachId(all[oldIndex].id);
        if (oldMeta.actor === 'agent' && String(oldMeta.renderKey || '').indexOf('renderer:layout-') === 0) addDetachId(all[oldIndex].id);
        // Link arrows created before renderKey was introduced are still
        // unambiguously renderer-owned by this generic actor/presentation
        // marker. Remove only that legacy subset during migration.
        if (all[oldIndex].type === 'arrow' && oldMeta.actor === 'agent' && oldMeta.actorLabel === 'DSH Whiteboard' && oldMeta.presentationRole === 'navigation') addDetachId(all[oldIndex].id);
      }
      // A render issued while the target page is already active has no
      // meaningful "back to overview" destination. Remove an older
      // renderer-owned self-reference and do not create another one.
      if (samePage) {
        for (var ri = 0; ri < all.length; ri++) {
          var samePageMeta = all[ri].meta || {};
          if (samePageMeta.actor === 'agent' && samePageMeta.renderKey === 'renderer:back-reference') addDetachId(all[ri].id);
        }
      }
      var headingStyle = presentationStyle(plan.presentation && plan.presentation.heading, 'presentation.heading');
      var navigationStyle = presentationStyle(plan.presentation && plan.presentation.navigation, 'presentation.navigation');
      var root = renderStyledNote(mods, headingStyle, plan.heading && plan.heading.text || targetPage.name, 40, 40, 'workspace-heading', { presentationRole: headingStyle.role, workspacePageId: targetPage.id });
      root.type = 'frame'; root.parentId = targetPage.id; root.props = { w: 1120, h: 720, name: plan.heading && plan.heading.text || targetPage.name };
      editor.run(function () {
        if (detachIds.length) editor.deleteShapes(detachIds);
        editor.createShapes([root]); created.push(root);
        var template = String(plan.layout && plan.layout.template || 'learning_moment_workspace');
        var labels = template === 'comparison' ? ['THESE', 'GEGENTHESE']
          : template === 'pro_con' ? ['PRO', 'CONTRA']
          : template === 'cause_effect' ? ['URSACHE', 'WIRKUNG'] : null;
        if (labels) {
          var headerY = root.y + 55, dividerY = root.y + 145, midX = root.x + root.props.w / 2;
          var layoutHeadingStyle = { role: 'layout-heading', shape: 'text', color: 'black', size: 'l' };
          var leftHeader = renderStyledText(mods, layoutHeadingStyle, labels[0], root.x + 210, headerY, 'layout-header-left', { layoutDecoration: true });
          var rightHeader = renderStyledText(mods, layoutHeadingStyle, labels[1], root.x + 700, headerY, 'layout-header-right', { layoutDecoration: true });
          var horizontal = { id: uniqueShapeId(mods), type: 'arrow', parentId: targetPage.id, x: root.x + 70, y: dividerY, props: { color: 'grey', start: { x: 0, y: 0 }, end: { x: root.props.w - 140, y: 0 }, text: '', arrowheadStart: 'none', arrowheadEnd: 'none' }, meta: { actor: 'agent', actorLabel: 'DSH Whiteboard', renderKey: 'renderer:layout-divider-horizontal', layoutDecoration: true } };
          var vertical = { id: uniqueShapeId(mods), type: 'arrow', parentId: targetPage.id, x: midX, y: dividerY, props: { color: 'grey', start: { x: 0, y: 0 }, end: { x: 0, y: root.props.h - 205 }, text: '', arrowheadStart: 'none', arrowheadEnd: 'none' }, meta: { actor: 'agent', actorLabel: 'DSH Whiteboard', renderKey: 'renderer:layout-divider-vertical', layoutDecoration: true } };
          editor.createShapes([leftHeader, rightHeader, horizontal, vertical]);
          created.push(leftHeader, rightHeader, horizontal, vertical);
        }
        for (var ei = 0; ei < elements.length; ei++) {
          var el = elements[ei];
          var style = presentationStyle(el.presentation, 'elements[' + ei + '].presentation');
          var x = style.role === 'anchor' ? 450 : 360 + (ei % 3) * 270;
          var y = style.role === 'anchor' ? 190 : 420 + Math.floor(ei / 3) * 230;
          var shape;
          if (style.shape === 'text') {
            if (el.source !== 'new' || typeof el.text !== 'string' || !el.text.trim()) throw new Error('Freitext muss neuer, nicht-leerer Text sein');
            shape = renderStyledText(mods, style, el.text, x, y, el.key);
          }
          else if (style.role === 'anchor') {
            var anchorContent = el.source === 'existing'
              ? propsToText(sourceShapes[el.key].props)
              : el.text;
            shape = renderStyledNote(mods, style, anchorContent, x, y, el.key, { sourceId: el.ref && el.ref.id || null });
          }
          else if (el.source === 'existing') shape = shapeCopy(mods, sourceShapes[el.key], style, x, y, el.key, el.text);
          else if (el.source === 'material' && el.material.presentation === 'image') shape = imageShape(mods, editor, el, style, x, y, el.key);
          else if (el.source === 'material') shape = renderStyledNote(mods, style, el.material.label || el.material.path, x, y, el.key, { sourcePath: el.material.path }, el.material.href);
          else if (el.source === 'document') shape = renderStyledNote(mods, style, el.document.label || el.document.path || el.document.documentId, x, y, el.key, { documentId: el.document.documentId || null, sourcePath: el.document.path || null }, el.document.href);
          else shape = renderStyledNote(mods, style, el.text || '', x, y, el.key);
          shape.parentId = targetPage.id;
          editor.createShapes([shape]); created.push(shape); byKey[el.key] = shape;
        }
        // Sticky notes auto-size from their contents. A fixed 230px row step
        // overlaps long cards, so lay out the created shapes a row at a time
        // using their real bounds. Four cards use two columns; larger plans
        // retain the compact three-column layout.
        var frameChildren = created.slice(1);
        // Fixed generic templates: paired forms alternate left/right; a
        // sequence/timeline is a horizontal reading order; matrix and cluster
        // use a stable grid. The domain supplies content, never geometry.
        var contentChildren = frameChildren.filter(function (shape) { return !(shape.meta && shape.meta.layoutDecoration); });
        var paired = template === 'comparison' || template === 'pro_con' || template === 'cause_effect';
        var horizontalFlow = template === 'sequence' || template === 'timeline';
        var columns = paired ? 2 : (horizontalFlow ? Math.max(1, contentChildren.length) : (template === 'matrix' ? 3 : (template === 'cluster' ? 3 : (elements.length <= 4 ? 2 : 3))));
        var noteWidth = 250, columnGap = 70;
        var gridWidth = columns * noteWidth + (columns - 1) * columnGap;
        var rowY = root.y + (labels ? 200 : 120);
        for (var rowStart = 0; rowStart < contentChildren.length; rowStart += columns) {
          var rowShapes = [];
          for (var layoutIndex = rowStart; layoutIndex < Math.min(rowStart + columns, contentChildren.length); layoutIndex++) {
            var freshShape = editor.getShape(contentChildren[layoutIndex].id);
            if (!freshShape) throw new Error('Render-Zettel nicht verfügbar');
            var x = root.x + Math.max(70, (root.props.w - gridWidth) / 2) + (layoutIndex - rowStart) * (noteWidth + columnGap);
            editor.updateShapes([{ id: freshShape.id, type: freshShape.type, x: x, y: rowY }]);
            rowShapes.push(editor.getShape(freshShape.id));
          }
          var rowBounds = boundsUnion(editor, rowShapes);
          rowY = rowBounds.y + rowBounds.h + 70;
        }
        // Grow the frame before converting only renderer-owned cards to
        // frame-local coordinates. Human shapes are deliberately excluded.
        var requiredHeight = Math.max(root.props.h, rowY - root.y + 30);
        var requiredWidth = horizontalFlow ? Math.max(root.props.w, 140 + contentChildren.length * (noteWidth + columnGap)) : root.props.w;
        editor.updateShapes([{ id: root.id, type: 'frame', props: Object.assign({}, root.props, { w: requiredWidth, h: requiredHeight }) }]);
        var freshRoot = editor.getShape(root.id);
        if (!freshRoot) throw new Error('Render-Frame nicht verfügbar');
        reparentRenderedShapesIntoFrame(editor, freshRoot, frameChildren);
        editor.sendToBack([freshRoot.id]);
      });
      var targetRef = pageHash(targetPage.id);
      if (plan.overview && plan.overview.action === 'ensure_navigation_reference' && !samePage) {
        await activatePage(editor, sourcePage.id);
        var refX = sourceBounds ? sourceBounds.x + sourceBounds.w + 30 : 80;
        var refY = sourceBounds ? sourceBounds.y : 80;
        var sourcePageShapes = editor.getCurrentPageShapes ? editor.getCurrentPageShapes() : [];
        var sourceDetachIds = [];
        for (var osi = 0; osi < sourcePageShapes.length; osi++) {
          var sourceMeta = sourcePageShapes[osi].meta || {};
          if (sourceMeta.actor === 'agent' && sourceMeta.renderKey === 'renderer:overview-reference') sourceDetachIds.push(sourcePageShapes[osi].id);
        }
        if (sourceDetachIds.length) editor.run(function () { editor.deleteShapes(sourceDetachIds); });
        editor.run(function () { var overviewShape = pageReference(mods, navigationStyle, plan.overview.label || 'Denkraum öffnen: ' + plan.page.title, targetRef, refX, refY, 'overview-reference'); overviewShape.parentId = sourcePage.id; editor.createShapes([overviewShape]); });
        await activatePage(editor, targetPage.id);
      }
      await waitForCurrentPage(editor, targetPage.id);
      if (!samePage) {
        var targetPageShapes = editor.getCurrentPageShapes ? editor.getCurrentPageShapes() : [];
        var backDetachIds = [];
        for (var bsi = 0; bsi < targetPageShapes.length; bsi++) {
          var backMeta = targetPageShapes[bsi].meta || {};
          if (backMeta.actor === 'agent' && backMeta.renderKey === 'renderer:back-reference') backDetachIds.push(targetPageShapes[bsi].id);
        }
        if (backDetachIds.length) editor.run(function () { editor.deleteShapes(backDetachIds); });
      }
      if (!samePage) editor.run(function () { var backShape = pageReference(mods, navigationStyle, '↩ Zur Übersicht', pageHash(sourcePage.id), 70, 650, 'back-reference'); backShape.parentId = targetPage.id; editor.createShapes([backShape]);
      var links = Array.isArray(plan.links) ? plan.links : [];
      for (var li = 0; li < links.length; li++) {
        var from = byKey[links[li].from], to = byKey[links[li].to];
        if (!from || !to) throw new Error('Link-Referenz nicht im RenderPlan: ' + links[li].from + ' -> ' + links[li].to);
        var fb = editor.getShapePageBounds(from.id), tb = editor.getShapePageBounds(to.id);
        var arrowId = uniqueShapeId(mods);
        var linkRenderKey = semanticLinkRenderKey(links[li], li);
        editor.createShapes([{ id: arrowId, type: 'arrow', parentId: targetPage.id, x: fb.x + fb.w / 2, y: fb.y + fb.h / 2,
          props: { color: 'light-violet', start: { x: 0, y: 0 }, end: { x: tb.x + tb.w / 2 - (fb.x + fb.w / 2), y: tb.y + tb.h / 2 - (fb.y + fb.h / 2) }, text: links[li].label || '' },
          meta: { actor: 'agent', actorLabel: 'DSH Whiteboard', presentationRole: navigationStyle.role, renderKey: linkRenderKey } }]);
        createArrowBindings(editor, arrowId, from.id, to.id);
      }
      });
      // Keep the browser deep link aligned with the page just rendered. Do
      // not re-apply a stale hash here: that would switch back to the page
      // that was active before this render transaction.
      var renderedHash = pageHash(targetPage.id);
      if (window.location.hash !== renderedHash) window.location.hash = renderedHash;
      return { pageId: targetPage.id, sourcePageId: sourcePage.id, created: created.length + 1 };
    }

    function execCommand(mods, editor, cmd) {
      var op = cmd && cmd.op;
      if (op === 'render-plan') {
        validateRenderSources(editor, cmd.plan);
        return renderSemanticPlan(mods, editor, cmd.plan).then(function (result) { return result || { rendered: true }; });
      }
      if (op === 'add-note') {
        var text = String(cmd.text || '').trim();
        if (!text) throw new Error('leerer Zetteltext');
        var pos = (typeof cmd.x === 'number' && typeof cmd.y === 'number') ? { x: cmd.x, y: cmd.y } : findFreeSpot(editor);
        editor.run(function () {
          editor.createShapes([{
            id: uniqueShapeId(mods), type: 'note', x: pos.x, y: pos.y,
            props: { color: 'light-violet', richText: toRichText(text) },
            meta: { actor: 'agent', actorLabel: 'DSH-Agent', at: cmd.at || Date.now() }
          }]);
        });
        return { created: 1 };
      }
      if (op === 'rename-frame') {
        var frame = null;
        try { frame = editor.getShape(normalizeShapeId(cmd.frameId)); } catch (err) {}
        if (!frame || frame.type !== 'frame') throw new Error('Frame nicht gefunden');
        var name = String(cmd.name || '').trim();
        if (!name) throw new Error('leerer Name');
        editor.run(function () {
          editor.updateShapes([{ id: frame.id, type: 'frame', props: { name: name }, meta: Object.assign({}, frame.meta, { clusterTitle: name.replace(/^🤖 Vorschlag: /, ''), renamedAt: Date.now() }) }]);
        });
        return { renamed: true };
      }
      if (op === 'frame-to-back') {
        var frame2 = null;
        try { frame2 = editor.getShape(normalizeShapeId(cmd.frameId)); } catch (err) {}
        if (!frame2 || frame2.type !== 'frame') throw new Error('Frame nicht gefunden');
        editor.run(function () { editor.sendToBack([frame2.id]); });
        return { sentToBack: true, frame: frame2.id };
      }
      if (op === 'bind-frame') {
        var frame3 = null;
        try { frame3 = editor.getShape(normalizeShapeId(cmd.frameId)); } catch (err) {}
        if (!frame3 || frame3.type !== 'frame') throw new Error('Frame nicht gefunden');
        var contained = [];
        var allS = editor.getCurrentPageShapes();
        var fbounds = editor.getShapePageBounds(frame3.id);
        if (!fbounds) throw new Error('Frame-Bounds nicht lesbar');
        for (var bi = 0; bi < allS.length; bi++) {
          var bs = allS[bi];
          if (bs.type !== 'note' || bs.parentId === frame3.id) continue;
          var bc = centerOf(editor, bs.id);
          if (!bc) continue;
          if (bc.x >= fbounds.x && bc.x <= fbounds.x + fbounds.w && bc.y >= fbounds.y && bc.y <= fbounds.y + fbounds.h) contained.push(bs);
        }
        var bound = 0;
        editor.run(function () { bound = reparentNotesIntoFrame(editor, frame3, contained); });
        return { bound: bound, frame: frame3.id };
      }
      if (op === 'arrange-sequence') {
        var items = Array.isArray(cmd.items) ? cmd.items : [];
        if (items.length < 2) throw new Error('mindestens zwei Zettel nötig');
        var seq = [];
        for (var si = 0; si < items.length; si++) {
          var sn = resolveNote(editor, items[si]);
          if (!sn) throw new Error('Zettel nicht gefunden: ' + truncate((items[si] && items[si].text) || items[si].id || '?', 40));
          seq.push(sn);
        }
        var x0 = typeof cmd.x === 'number' ? cmd.x : 80;
        var y0 = typeof cmd.y === 'number' ? cmd.y : 80;
        var step = typeof cmd.step === 'number' ? cmd.step : 280;
        var frameName = String(cmd.frameName || 'Phasen').trim() || 'Phasen';
        editor.run(function () {
          var oldArrows = [];
          var allS0 = editor.getCurrentPageShapes();
          for (var ai = 0; ai < allS0.length; ai++) {
            var as2 = allS0[ai];
            if (as2.type === 'arrow' && as2.meta && as2.meta.actor === 'agent') oldArrows.push(as2.id);
          }
          if (oldArrows.length) editor.deleteShapes(oldArrows);
          for (var mi = 0; mi < seq.length; mi++) {
            var target = seq[mi];
            var nextMeta = Object.assign({}, target.meta);
            if (nextMeta.actor === 'human') nextMeta.movedBy = 'agent';
            editor.updateShapes([{ id: target.id, type: 'note', x: x0 + mi * step, y: y0, meta: nextMeta }]);
          }
          var fb = { x: x0 - 60, y: y0 - 100, w: step * (seq.length - 1) + 230 + 120, h: 220 + 160 };
          var frameId = null;
          var allF = editor.getCurrentPageShapes();
          for (var fi = 0; fi < allF.length; fi++) {
            var fs = allF[fi];
            if (fs.type !== 'frame') continue;
            if ((fs.meta || {}).clusterTitle === frameName) { frameId = fs.id; break; }
          }
          if (frameId) {
            editor.updateShapes([{ id: frameId, type: 'frame', x: fb.x, y: fb.y, props: { w: fb.w, h: fb.h, name: frameName } }]);
          } else {
            frameId = uniqueShapeId(mods);
            editor.createShapes([{
              id: frameId, type: 'frame', x: fb.x, y: fb.y,
              props: { w: fb.w, h: fb.h, name: frameName },
              meta: { actor: 'agent', actorLabel: 'DSH-Agent', proposal: false, adoptedAt: Date.now(), clusterTitle: frameName }
            }]);
          }
          editor.sendToBack([frameId]);
          reparentNotesIntoFrame(editor, editor.getShape(frameId), seq);
          for (var ci2 = 0; ci2 < seq.length - 1; ci2++) {
            var arrowId = uniqueShapeId(mods);
            editor.createShapes([{
              id: arrowId, type: 'arrow', x: x0 + ci2 * step + 115, y: y0 + 110,
              props: { color: 'light-violet', start: { x: 0, y: 0 }, end: { x: step, y: 0 }, text: 'dann' },
              meta: { actor: 'agent', actorLabel: 'DSH-Agent', proposal: false, at: Date.now() }
            }]);
            try { createArrowBindings(editor, arrowId, seq[ci2].id, seq[ci2 + 1].id); } catch (berr) {
              pushActivity('⚠️ Pfeil-Bindung fehlgeschlagen: ' + String(berr && berr.message || berr));
            }
          }
        });
        return { arranged: seq.length, frame: frameName };
      }
      if (op === 'propose-clusters') {
        var clusters = Array.isArray(cmd.clusters) ? cmd.clusters : [];
        if (!clusters.length) throw new Error('keine Cluster übergeben');
        var created = [];
        var reused = [];
        editor.run(function () {
          var allShapes = editor.getCurrentPageShapes();
          for (var ci = 0; ci < clusters.length; ci++) {
            var cluster = clusters[ci] || {};
            var title = String(cluster.title || 'Cluster').trim() || 'Cluster';
            var members = [];
            var missingTexts = [];
            var refs = [];
            var ids = Array.isArray(cluster.noteIds) ? cluster.noteIds : [];
            var texts = Array.isArray(cluster.noteTexts) ? cluster.noteTexts : [];
            for (var a = 0; a < ids.length; a++) refs.push({ id: ids[a] });
            for (var b2 = 0; b2 < texts.length; b2++) refs.push({ text: texts[b2] });
            for (var r = 0; r < refs.length; r++) {
              var found = resolveNote(editor, refs[r]);
              if (found) members.push(found);
              else if (refs[r].text) missingTexts.push(String(refs[r].text));
            }
            var existingFrame = null;
            for (var fi = 0; fi < allShapes.length; fi++) {
              var fs2 = allShapes[fi];
              if (fs2.type !== 'frame') continue;
              var fm = fs2.meta || {};
              if (fm.proposal === true && fm.clusterTitle === title) { existingFrame = fs2; break; }
            }
            if (existingFrame) {
              var u0 = boundsUnion(editor, members);
              editor.updateShapes([{ id: existingFrame.id, type: 'frame', x: u0.x - 60, y: u0.y - 110, props: { w: u0.w + 120, h: u0.h + 170, name: '🤖 Vorschlag: ' + title } }]);
              editor.sendToBack([existingFrame.id]);
              reused.push(title);
              continue;
            }
            var frameId2 = uniqueShapeId(mods);
            editor.createShapes([{
              id: frameId2, type: 'frame', x: 0, y: 0,
              props: { w: 200, h: 140, name: '🤖 Vorschlag: ' + title },
              meta: { actor: 'agent', actorLabel: 'DSH-Agent', proposal: true, proposalId: 'p' + Date.now().toString(36) + '-' + ci, clusterTitle: title, at: cmd.at || Date.now() }
            }]);
            var base = members.length ? boundsUnion(editor, members) : { x: 80, y: 80, w: 0, h: 0 };
            for (var m = 0; m < missingTexts.length; m++) {
              var nid = uniqueShapeId(mods);
              editor.createShapes([{
                id: nid, type: 'note',
                x: base.x + (m % 3) * 250, y: base.y + base.h + 50 + Math.floor(m / 3) * 240,
                props: { color: 'light-violet', richText: toRichText(missingTexts[m]) },
                meta: { actor: 'agent', actorLabel: 'DSH-Agent', proposal: true, fromCluster: title, at: cmd.at || Date.now() }
              }]);
              var fresh = editor.getShape(nid);
              if (fresh) members.push(fresh);
            }
            var u = boundsUnion(editor, members);
            editor.updateShapes([{ id: frameId2, type: 'frame', x: u.x - 60, y: u.y - 110, props: { w: u.w + 120, h: u.h + 170, name: '🤖 Vorschlag: ' + title } }]);
            editor.sendToBack([frameId2]);
            created.push(title);
          }
        });
        return { frames: created.length, reused: reused.length, titles: created };
      }
      if (op === 'connect-notes') {
        var from = resolveNote(editor, cmd.from);
        var to = resolveNote(editor, cmd.to);
        if (!from || !to) throw new Error('Zettel für Verbindung nicht gefunden');
        var fb2 = editor.getShapePageBounds(from.id);
        var tb = editor.getShapePageBounds(to.id);
        if (!fb2 || !tb) throw new Error('Zettel-Positionen nicht lesbar');
        var fx = fb2.x + fb2.w / 2, fy = fb2.y + fb2.h / 2;
        var tx = tb.x + tb.w / 2, ty = tb.y + tb.h / 2;
        var props = { color: 'light-violet', start: { x: 0, y: 0 }, end: { x: tx - fx, y: ty - fy } };
        if (cmd.label) props.text = String(cmd.label);
        var arrowId2 = uniqueShapeId(mods);
        editor.run(function () {
          editor.createShapes([{
            id: arrowId2, type: 'arrow', x: fx, y: fy, props: props,
            meta: { actor: 'agent', actorLabel: 'DSH-Agent', proposal: true, at: cmd.at || Date.now() }
          }]);
          try { createArrowBindings(editor, arrowId2, from.id, to.id); } catch (berr2) {
            pushActivity('⚠️ Pfeil-Bindung fehlgeschlagen: ' + String(berr2 && berr2.message || berr2));
          }
        });
        return { connected: true };
      }
      if (op === 'highlight-notes') {
        var targetIds = [];
        var idRefs = Array.isArray(cmd.noteIds) ? cmd.noteIds : [];
        var textRefs = Array.isArray(cmd.noteTexts) ? cmd.noteTexts : [];
        for (var p = 0; p < idRefs.length; p++) {
          var s2 = resolveNote(editor, { id: idRefs[p] });
          if (s2) targetIds.push(s2.id);
        }
        for (var q = 0; q < textRefs.length; q++) {
          var s3 = resolveNote(editor, { text: textRefs[q] });
          if (s3) targetIds.push(s3.id);
        }
        if (!targetIds.length) throw new Error('keine passenden Zettel gefunden');
        editor.setSelectedShapes(targetIds);
        try { editor.zoomToSelection({ instant: true }); } catch (err2) { try { editor.zoomToSelection(); } catch (err3) {} }
        return { highlighted: targetIds.length };
      }
      throw new Error('unbekannte Operation: ' + op);
    }

    function buildSnapshot(editor, commandResults) {
      var shapes = editor.getCurrentPageShapes();
      var notes = [];
      var frames = [];
      var arrows = [];
      var elements = [];
      var i, s, meta, b;
      for (i = 0; i < shapes.length; i++) {
        s = shapes[i];
        meta = s.meta || {};
        try { b = editor.getShapePageBounds(s.id); } catch (boundsError) { b = null; }
        var shapeText = propsToText(s.props);
        if (!shapeText && s.type === 'frame') shapeText = s.props && s.props.name || '';
        if (!shapeText && s.type === 'geo') shapeText = s.props && s.props.geo || '';
        if (!shapeText && s.type === 'image') shapeText = s.props && s.props.altText || '';
        shapeText = truncate(shapeText, 200);
        elements.push({
          id: s.id, type: s.type,
          geo: s.type === 'geo' && s.props && s.props.geo ? String(s.props.geo) : null,
          text: shapeText,
          x: Math.round(Number(s.x) || 0), y: Math.round(Number(s.y) || 0),
          position: { x: Math.round(Number(s.x) || 0), y: Math.round(Number(s.y) || 0) },
          bounds: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : null,
          rotation: Number(s.rotation) || 0,
          parentId: String(s.parentId || ''),
          actor: meta.actor === 'agent' ? 'agent' : 'human',
          proposal: meta.proposal === true,
          movedBy: meta.movedBy || null
        });
        if (s.type !== 'note') continue;
        notes.push({
          id: s.id, text: shapeText,
          x: Math.round(s.x), y: Math.round(s.y),
          parentId: String(s.parentId || ''),
          actor: meta.actor === 'agent' ? 'agent' : 'human',
          proposal: meta.proposal === true,
          movedBy: meta.movedBy || null
        });
      }
      for (i = 0; i < shapes.length; i++) {
        s = shapes[i];
        if (s.type !== 'frame') continue;
        meta = s.meta || {};
        b = editor.getShapePageBounds(s.id);
        var memberIds = [];
        for (var j = 0; j < notes.length; j++) {
          if (notes[j].parentId === s.id) { memberIds.push(notes[j].id); continue; }
          var nb = editor.getShapePageBounds(notes[j].id);
          if (!b || !nb) continue;
          var cx = nb.x + nb.w / 2, cy = nb.y + nb.h / 2;
          if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) memberIds.push(notes[j].id);
        }
        frames.push({
          id: s.id, name: truncate((s.props && s.props.name) || '', 120),
          x: b ? Math.round(b.x) : 0, y: b ? Math.round(b.y) : 0,
          w: b ? Math.round(b.w) : 0, h: b ? Math.round(b.h) : 0,
          actor: meta.actor === 'agent' ? 'agent' : 'human',
          proposal: meta.proposal === true,
          clusterTitle: meta.clusterTitle || null,
          memberIds: memberIds
        });
      }
      for (i = 0; i < shapes.length; i++) {
        s = shapes[i];
        if (s.type !== 'arrow') continue;
        meta = s.meta || {};
        arrows.push({ id: s.id, actor: meta.actor === 'agent' ? 'agent' : 'human', proposal: meta.proposal === true, label: truncate(propsToText(s.props), 100), bound: countBindingsFor(editor, s.id) > 0 });
      }
      var human = 0, agent = 0;
      for (i = 0; i < notes.length; i++) { if (notes[i].actor === 'agent') agent++; else human++; }
      var proposals = [];
      for (i = 0; i < frames.length; i++) {
        if (!frames[i].proposal) continue;
        proposals.push({ frameId: frames[i].id, title: frames[i].clusterTitle || frames[i].name, memberCount: frames[i].memberIds.length, memberIds: frames[i].memberIds });
      }
      return {
        elements: elements.slice(0, 600),
        notes: notes.slice(0, 400),
        frames: frames.slice(0, 200),
        arrows: arrows.slice(0, 400),
        proposals: proposals,
        selection: readSelection(editor),
        page: readCurrentPage(editor),
        counts: { notes: notes.length, human: human, agent: agent, proposals: proposals.length },
        commandResults: commandResults || []
      };
    }

    function describeCommand(cmd) {
      if (!cmd) return 'Aktion ausgeführt';
      if (cmd.op === 'add-note') return 'Zettel ergänzt: „' + truncate(cmd.text, 40) + '“';
      if (cmd.op === 'rename-frame') return 'Cluster umbenannt: „' + truncate(cmd.name, 40) + '“';
      if (cmd.op === 'frame-to-back') return 'Frame hinter die Zettel gelegt';
      if (cmd.op === 'bind-frame') return 'Frame-Kinderverbindung hergestellt';
      if (cmd.op === 'arrange-sequence') return 'Reihenfolge geordnet in Frame „' + truncate(cmd.frameName, 40) + '“';
      if (cmd.op === 'propose-clusters') {
        var names = (Array.isArray(cmd.clusters) ? cmd.clusters : []).map(function (c) { return c && c.title; }).filter(Boolean);
        return 'Cluster-Vorschläge platziert: ' + names.join(', ');
      }
      if (cmd.op === 'connect-notes') return 'Verbindung vorgeschlagen';
      if (cmd.op === 'highlight-notes') return 'Zettel hervorgehoben';
      return String(cmd.op);
    }

    function useBoardUi() {
      var st = React.useState(0);
      React.useEffect(function () {
        var fn = function () { st[1](function (v) { return v + 1; }); };
        uiSubs.push(fn);
        return function () { var idx = uiSubs.indexOf(fn); if (idx >= 0) uiSubs.splice(idx, 1); };
      }, []);
      return uiState;
    }

    // ---- Änderungs-Tracker: das Board hat keine Historie, also führen wir sie ----
    var changeLog = [];
    var feedbackMarker = 0;

    function boardSignature(snap) {
      var parts = [];
      var es = snap.elements || [];
      for (var e = 0; e < es.length; e++) {
        parts.push(es[e].id + ':' + es[e].type + ':' + (es[e].geo || '') + ':' + es[e].x + ':' + es[e].y + ':' + (es[e].bounds ? es[e].bounds.w + 'x' + es[e].bounds.h : '') + ':' + es[e].rotation + ':' + (es[e].parentId || '') + ':' + es[e].actor + ':' + es[e].text);
      }
      var ns = snap.notes || [];
      for (var i = 0; i < ns.length; i++) {
        parts.push(ns[i].id + ':' + ns[i].x + ':' + ns[i].y + ':' + ns[i].actor + ':' + (ns[i].parentId || '') + ':' + ns[i].text);
      }
      var fs = snap.frames || [];
      for (var j = 0; j < fs.length; j++) {
        parts.push(fs[j].id + '#' + fs[j].name + '#' + fs[j].proposal);
      }
      return parts.join('|');
    }

    function recordChanges(prev, next) {
      try {
        var diffs = diffSnapshots(prev, next);
        var agentTouched = false;
        for (var i = 0; i < diffs.length; i++) {
          changeLog.push({ at: Date.now(), text: diffs[i] });
          if (diffs[i].indexOf('(Agent)') >= 0) agentTouched = true;
        }
        if (changeLog.length > 80) changeLog = changeLog.slice(-80);
        // Agent hat das Board verändert → Panel kurz zeigen, dann wieder Ruhe.
        if (agentTouched) showPanelBriefly(5000);
      } catch (err) {}
    }

    function diffSnapshots(prev, next) {
      var out = [];
      var prevNotes = {};
      var i;
      var pn = prev.notes || [];
      for (i = 0; i < pn.length; i++) prevNotes[pn[i].id] = pn[i];
      var nextIds = {};
      var nn = next.notes || [];
      for (i = 0; i < nn.length; i++) {
        var n = nn[i];
        nextIds[n.id] = true;
        var p = prevNotes[n.id];
        if (!p) {
          out.push('neuer Zettel „' + truncate(n.text, 30) + '“' + (n.actor === 'agent' ? ' (Agent)' : ' (Mensch)'));
          continue;
        }
        var who = (n.actor === 'agent' || n.movedBy === 'agent') ? ' (Agent)' : '';
        if (p.text !== n.text) {
          out.push('Zettel geändert: „' + truncate(p.text, 22) + '“ → „' + truncate(n.text, 22) + '“' + who);
        }
        if (Math.abs((p.x || 0) - (n.x || 0)) > 4 || Math.abs((p.y || 0) - (n.y || 0)) > 4) {
          out.push('Zettel verschoben: „' + truncate(n.text, 24) + '“' + who);
        }
        if ((p.parentId || '') !== (n.parentId || '')) {
          out.push('Cluster-Zugehörigkeit geändert: „' + truncate(n.text, 24) + '“' + who);
        }
      }
      for (i = 0; i < pn.length; i++) {
        if (!nextIds[pn[i].id]) out.push('Zettel entfernt: „' + truncate(pn[i].text, 24) + '“' + (pn[i].actor === 'agent' ? ' (Agent)' : ''));
      }
      var prevFrames = {};
      var pf = prev.frames || [];
      for (i = 0; i < pf.length; i++) prevFrames[pf[i].id] = pf[i];
      var nextFrameIds = {};
      var nf = next.frames || [];
      for (i = 0; i < nf.length; i++) {
        nextFrameIds[nf[i].id] = true;
        var f = nf[i];
        var fp = prevFrames[f.id];
        var fwho = f.actor === 'agent' ? ' (Agent)' : '';
        if (!fp) out.push('neuer Container: „' + truncate(f.name, 30) + '“' + fwho);
        else if (fp.name !== f.name) out.push('Container umbenannt: „' + truncate(fp.name, 22) + '“ → „' + truncate(f.name, 22) + '“' + fwho);
        else if (fp.proposal !== f.proposal) out.push('Vorschlag „' + truncate(f.name, 24) + '“ ' + (f.proposal ? 'wieder offen' : 'übernommen') + fwho);
      }
      for (i = 0; i < pf.length; i++) {
        if (!nextFrameIds[pf[i].id]) out.push('Container entfernt: „' + truncate(pf[i].name, 24) + '“');
      }
      return out;
    }

    function pendingChanges(limit) {
      var out = [];
      for (var i = feedbackMarker; i < changeLog.length; i++) out.push(changeLog[i].text);
      if (out.length > (limit || 12)) out = out.slice(out.length - (limit || 12));
      return out;
    }

    function markFeedbackSeen() {
      feedbackMarker = changeLog.length;
      pushUi();
    }

    // ---- Tab body: registered into the keyed `sidebar.right.pane.tab` seat ----
    function BoardBody(props) {
      var containerRef = React.useRef(null);
      var ui = useBoardUi();
      // The right-sidebar contract supplies both a plain sessionId and the
      // session-bound useSession hook.  A tab can be mounted during the first
      // scope transition before the plain prop has been copied through a
      // custom slot wrapper, so derive the identity from the already-bound
      // hook as well.  Never fall back to a process-global snapshot: that
      // could expose another session's board.
      var hookSessionId = props && typeof props.useSession === 'function'
        ? props.useSession(function (snapshot) { return snapshot && snapshot.sessionId ? String(snapshot.sessionId) : null; })
        : null;
      var sessionId = props && props.sessionId ? String(props.sessionId) : hookSessionId;
      var tabInfo = props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
      var sidebarExpanded = tabInfo && tabInfo.sidebar ? tabInfo.sidebar.expanded : null;
      var tabVisible = tabInfo && tabInfo.tab ? tabInfo.tab.visible : null;
      var key = 'dsh-whiteboard-session-' + (sessionId || 'shared');
      var wasBoardOpen = React.useRef(false);
      if (!migrateFromKey) migrateFromKey = key;

      React.useEffect(function () {
        if (!sessionId) return;
        rememberSession(sessionId);
        rememberBoardOpen();
      }, [sessionId]);

      React.useEffect(function () {
        if (!sessionId || typeof EventSource !== 'function') return;
        var source = new EventSource(COMMAND_EVENTS_URL + '?sessionId=' + encodeURIComponent(sessionId));
        // The DSH host keeps compact live snapshots only in memory. After a
        // host restart an already-mounted editor reconnects its EventSource,
        // but has no local mutation that would otherwise trigger a snapshot.
        // Force exactly one bootstrap sync per EventSource connection.
        source.addEventListener('open', function () {
          if (commandConsumer) commandConsumer([], true);
        });
        source.addEventListener('whiteboard-commands', function (event) {
          var message;
          try { message = JSON.parse(event.data || '{}'); } catch (error) { return; }
          var commands = Array.isArray(message.commands) ? message.commands : [];
          if (commandConsumer) commandConsumer(commands, true);
          else if (commands.length) deferredCommandEvents = deferredCommandEvents.concat(commands);
        });
        return function () { source.close(); };
      }, [sessionId]);

      React.useEffect(function () {
        var isOpen = sidebarExpanded === true && tabVisible !== false;
        if (isOpen) {
          // Mark the preference only after the tab is observably open. During
          // reload the tab body can briefly receive the closed/unknown state;
          // that transient lifecycle state must not erase the persisted
          // preference before Opener gets a chance to reopen it.
          wasBoardOpen.current = true;
          rememberBoardOpen();
        } else if (wasBoardOpen.current && (sidebarExpanded === false || tabVisible === false)) {
          // A real close after an observed open is an explicit user choice.
          wasBoardOpen.current = false;
          rememberBoardClosed();
        }
      }, [sidebarExpanded, tabVisible]);

      function startBoard() {
        if (!sessionId) {
          pushUi({ phase: 'error', error: 'Whiteboard-Session fehlt' });
          return;
        }
        resolveBoardIdentity(sessionId).then(function (identity) {
          if (boardSessionId !== null && boardSessionId !== sessionId) resetMountedBoard();
          if (boardKey !== null && boardKey !== identity.persistenceKey) resetMountedBoard();
          if (!boardRoot && !editorHolder.editor) {
            initBoardWhenVisible(function () { return containerRef.current; }, identity.persistenceKey, sessionId, 0);
          }
        }).catch(function (error) {
          pushUi({ phase: 'error', error: String((error && error.message) || error) });
          console.error('[dsh-whiteboard] board identity resolution failed', error);
        });
      }

      React.useEffect(function () {
        if (!boardHost) return;
        var el = containerRef.current;
        if (!el) return;
        // The canvas host is intentionally global so a tldraw editor is not
        // React-unmounted while a sidebar seat is merely moved. A session
        // change still gets a fresh editor, but its persistence key is the
        // workspace board identity shared by all sessions in that workspace.
        if (boardHost.parentNode !== el) {
          if (boardHost.parentNode) boardHost.parentNode.removeChild(boardHost);
          el.appendChild(boardHost);
        }
        var cancelled = false;
        requestedSessionId = sessionId || null;
        if (!sessionId) {
          if (boardSessionId !== null) resetMountedBoard();
        } else {
          resolveBoardIdentity(sessionId).then(function (identity) {
            if (cancelled) return;
            if (boardSessionId !== null && boardSessionId !== sessionId) resetMountedBoard();
            if (boardKey !== null && boardKey !== identity.persistenceKey) resetMountedBoard();
            if (!boardRoot && !editorHolder.editor) {
              initBoardWhenVisible(function () { return containerRef.current; }, identity.persistenceKey, sessionId, 0);
            }
          }).catch(function (error) {
            if (cancelled) return;
            pushUi({ phase: 'error', error: String((error && error.message) || error) });
            console.error('[dsh-whiteboard] board identity resolution failed', error);
          });
        }
        return function () {
          cancelled = true;
          if (requestedSessionId === sessionId) requestedSessionId = null;
        };
      }, [key]);

      function adoptProposal(frameId) {
        var editor = editorHolder.editor;
        if (!editor) { pushActivity('⚠️ Board noch nicht bereit'); return; }
        try {
          var id = normalizeShapeId(frameId);
          var shape = editor.getShape(id);
          if (!shape) { pushActivity('⚠️ Vorschlag nicht gefunden'); return; }
          var reparented = 0;
          editor.run(function () {
            editor.updateShapes([{ id: shape.id, type: 'frame', meta: Object.assign({}, shape.meta, { proposal: false, adoptedAt: Date.now() }) }]);
            var contained = [];
            var allS = editor.getCurrentPageShapes();
            var fb = editor.getShapePageBounds(shape.id);
            if (fb) {
              for (var i = 0; i < allS.length; i++) {
                var s = allS[i];
                if (s.type !== 'note' || s.parentId === shape.id) continue;
                var b = editor.getShapePageBounds(s.id);
                if (!b) continue;
                var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                if (cx >= fb.x && cx <= fb.x + fb.w && cy >= fb.y && cy <= fb.y + fb.h) contained.push(s);
              }
            }
            reparented = reparentNotesIntoFrame(editor, shape, contained);
          });
          pushActivity('🧑 Du: Vorschlag übernommen' + (reparented ? ' (' + reparented + ' Zettel eingebunden)' : ''));
        } catch (err) {
          pushActivity('⚠️ Übernehmen fehlgeschlagen: ' + String(err && err.message || err));
        }
      }

      function discardProposal(frameId) {
        var editor = editorHolder.editor;
        if (!editor) { pushActivity('⚠️ Board noch nicht bereit'); return; }
        try {
          editor.run(function () { editor.deleteShapes([normalizeShapeId(frameId)]); });
          pushActivity('🧑 Du: Cluster-Vorschlag verworfen (Zettel bleiben)');
        } catch (err) {
          pushActivity('⚠️ Verwerfen fehlgeschlagen: ' + String(err && err.message || err));
        }
      }

      function zoomToShape(shapeId) {
        var editor = editorHolder.editor;
        if (!editor) return;
        try {
          editor.setSelectedShapes([normalizeShapeId(shapeId)]);
          editor.zoomToSelection({ instant: true });
        } catch (err) {}
      }

      var counts = ui.counts;
      var notes = ui.notes;
      var proposals = ui.proposals;
      var activity = ui.activity;
      var selection = ui.selection || [];

      // --- Agenten-Trigger: das Board kann den Agenten nicht selbst wecken.
      // Der Knopf schreibt einen kontextbewussten Prompt in den Composer und
      // sendet ihn ab (Standard-Prop `inputActions` session-scoped Slots).
      var inputActions = props && props.inputActions ? props.inputActions : null;
      var selectedNotes = selection.filter(function (s) { return s.kind === 'note' && s.text; });
      var selectionPhrase = selectedNotes.length
        ? ' Ausgewählt habe ich: ' + selectedNotes.map(function (s) { return '„' + s.text + '“'; }).join(', ') + '.'
        : '';

      function triggerAgent(kind) {
        if (!inputActions) {
          pushActivity('⚠️ Kein Composer-Zugriff (inputActions fehlt) — Prompt bitte manuell senden');
          return;
        }
        var prompt;
        if (kind === 'feedback') {
          var deltas = pendingChanges(12);
          prompt = 'Schau dir das Whiteboard an (whiteboard_state) und gib mir ein KURZES Feedback (3–5 Sätze, konkret, keine Wiederholung des Offensichtlichen).' +
            (deltas.length ? ' Seit meinem letzten Feedback auf dem Board: ' + deltas.join('; ') + '.' : '') +
            selectionPhrase +
            ' Nenne mir höchstens einen konkreten Verbesserungsvorschlag.';
        } else if (kind === 'cluster') {
          prompt = 'Schau dir das Whiteboard an (whiteboard_state) und schlage sinnvolle Cluster als Frames vor.' + selectionPhrase;
        } else if (kind === 'ideas') {
          prompt = 'Schau dir das Whiteboard an (whiteboard_state) und ergänze 2–3 neue Ideen als Zettel, die zum bestehenden Stand passen.' + selectionPhrase;
        } else {
          prompt = 'Schau dir das Whiteboard an (whiteboard_state) und reagiere auf den aktuellen Stand.' + selectionPhrase + ' Was fällt dir dazu ein?';
        }
        try {
          inputActions.setDraft(prompt);
          if (kind === 'feedback') markFeedbackSeen();
          clientCtx.timeout(function () { try { inputActions.submit(); } catch (e) {} }, 60);
        } catch (err) {
          pushActivity('⚠️ Agenten-Trigger fehlgeschlagen: ' + String(err && err.message || err));
        }
      }

      var pendingCount = changeLog.length - feedbackMarker;
      var triggerRow = React.createElement('div', { className: 'wb-actions' },
        React.createElement('button', {
          className: 'wb-btn wb-btn-primary',
          title: 'Agenten-Turn starten: er schaut aufs Board und antwortet (Auswahl wird mitgeschickt)',
          onClick: function () { triggerAgent('ask'); }
        }, '🤖 Dazu fragen' + (selectedNotes.length ? ' (' + selectedNotes.length + ')' : '')),
        React.createElement('button', {
          className: 'wb-btn wb-btn-primary',
          title: 'Agenten-Turn starten: kurzes Feedback zu den Änderungen seit dem letzten Feedback',
          onClick: function () { triggerAgent('feedback'); }
        }, '🔍 Feedback' + (pendingCount > 0 ? ' (' + pendingCount + ')' : '')),
        React.createElement('button', {
          className: 'wb-btn',
          title: 'Agenten-Turn starten: Cluster-Vorschläge anfordern',
          onClick: function () { triggerAgent('cluster'); }
        }, '🤖 Cluster vorschlagen'),
        React.createElement('button', {
          className: 'wb-btn',
          title: 'Agenten-Turn starten: Ideen ergänzen lassen',
          onClick: function () { triggerAgent('ideas'); }
        }, '🤖 Ideen ergänzen')
      );
      var changeRows = pendingChanges(8).map(function (c, idx) {
        return React.createElement('div', { key: idx, className: 'wb-change-row' }, '• ' + c);
      });

      var noteRows = notes.map(function (n) {
        return React.createElement('div', {
          key: n.id, className: 'wb-note-row', title: 'Auf dem Board anzeigen',
          onClick: function () { zoomToShape(n.id); }
        },
          React.createElement('span', { className: 'wb-badge ' + (n.actor === 'agent' ? 'wb-badge-agent' : 'wb-badge-human') }, n.actor === 'agent' ? '🤖 Agent' : '🧑 Du'),
          React.createElement('span', { className: 'wb-note-text' }, truncate(n.text, 60) || '(leer)')
        );
      });

      var proposalRows = proposals.map(function (p) {
        return React.createElement('div', { key: p.frameId, className: 'wb-proposal' },
          React.createElement('div', { className: 'wb-proposal-title' }, '🤖 „' + truncate(p.title, 34) + '“ — ' + p.memberCount + ' Zettel'),
          React.createElement('div', { className: 'wb-proposal-actions' },
            React.createElement('button', { className: 'wb-btn', onClick: function () { adoptProposal(p.frameId); } }, 'Übernehmen'),
            React.createElement('button', { className: 'wb-btn', onClick: function () { discardProposal(p.frameId); } }, 'Verwerfen')
          )
        );
      });

      var activityRows = activity.map(function (a, idx) {
        return React.createElement('div', { key: idx, className: 'wb-activity-row' }, a);
      });

      var panelVisible = panelIsVisible();

      var panel = React.createElement('div', { className: 'wb-panel' },
        React.createElement('h4', { className: 'wb-panel-title' }, '📋 Whiteboard-Log'),
        React.createElement('h4', null, 'Seit letztem Feedback (' + pendingCount + ')'),
        changeRows.length ? React.createElement('div', { className: 'wb-changes' }, changeRows) : React.createElement('div', { className: 'wb-empty' }, 'Keine Änderungen seit dem letzten Feedback.'),
        React.createElement('h4', null, 'Zettel (' + notes.length + ')'),
        noteRows.length ? noteRows : React.createElement('div', { className: 'wb-empty' }, 'Noch keine Zettel.'),
        proposals.length ? React.createElement('h4', { style: { marginTop: '8px' } }, 'Cluster-Vorschläge') : null,
        proposalRows,
        activity.length ? React.createElement('div', { className: 'wb-activity' }, activityRows) : null
      );

      return React.createElement('div', { className: 'wb-view' },
        React.createElement('div', { className: 'wb-header' },
          React.createElement('span', { className: 'wb-title' }, '🧩 Whiteboard'),
          React.createElement('span', { className: 'wb-counts', title: 'Zettel gesamt (🧑 Mensch · 🤖 Agent)' }, 'Zettel: ' + counts.notes + ' (🧑 ' + counts.human + ' · 🤖 ' + counts.agent + ')'),
          counts.proposals ? React.createElement('span', { className: 'wb-counts' }, 'Vorschläge: ' + counts.proposals) : null,
          React.createElement('span', { className: 'wb-spacer' }),
          triggerRow,
          React.createElement('button', {
            className: 'wb-btn',
            title: 'Whiteboard-Log: Änderungen seit dem letzten Feedback, Zettel-Liste, Cluster-Vorschläge, Aktivitätsprotokoll. Blendet sich nach Agentenänderungen automatisch kurz ein.',
            onClick: function () { panelOpenFlag = !panelVisible; panelAutoUntil = 0; pushUi(); }
          }, panelVisible ? '📋 Log ausblenden' : '📋 Log einblenden')
        ),
        React.createElement('div', { className: 'wb-body' },
          React.createElement('div', { className: 'wb-mount', ref: containerRef }),
          ui.phase === 'loading' ? React.createElement('div', { className: 'wb-loading' }, 'Lade tldraw …') : null,
          ui.phase === 'error' ? React.createElement('div', { className: 'wb-error' },
            React.createElement('div', null, 'tldraw konnte nicht geladen werden: ' + ui.error),
            React.createElement('button', { className: 'wb-btn', onClick: function () { pushUi({ phase: 'loading', error: '' }); startBoard(); } }, 'Erneut versuchen')
          ) : null,
          panelVisible ? panel : null
        )
      );
    }

    // ---- Opener chip: floating entry point in the frame-wide overlay ----
    function Opener(props) {
      var ui = useBoardUi();
      var hookSessionId = props && typeof props.useSession === 'function'
        ? props.useSession(function (snapshot) { return snapshot && snapshot.sessionId ? String(snapshot.sessionId) : null; })
        : null;
      // `shell.overlay` is root-scoped. It therefore receives the root
      // `useSessions` hook, not the session-scoped `useSession` hook that the
      // sidebar tab body receives. Without this projection the opener never
      // subscribes to the session-bound open-event stream, so a host request
      // cannot open the board for the active Companion session.
      var rootSessionId = props && typeof props.useSessions === 'function'
        ? props.useSessions(function (state) { return state && state.current ? String(state.current) : null; })
        : null;
      var sessionId = props && props.sessionId ? String(props.sessionId) : (hookSessionId || rootSessionId);
      // The overlay can mount before DSH has rehydrated `state.current`.
      // Keep the newest identity available to retries instead of treating an
      // unscoped `openTab` call as a successful restore.
      var activeSessionRef = React.useRef(sessionId || null);
      activeSessionRef.current = sessionId || null;

      React.useEffect(function () {
        var opening = false;
        var disposed = false;
        function openBoard(targetSessionId) {
          // `openTab()` without an identity can succeed while the session
          // surface is still absent. That is not a usable board and must keep
          // the reload retry alive until a concrete session exists.
          if (!targetSessionId || opening || !sidebarRef.open) return false;
          opening = true;
          var opened = false;
          try { opened = sidebarRef.open(TYPE_KIND, targetSessionId) === true; } catch (err) {}
          if (opened) rememberBoardOpen();
          clientCtx.timeout(function () { opening = false; }, opened ? 1000 : 120);
          return opened;
        }
        function retryUntilBoardBodyBinds(targetSessionId, attempts, onBound) {
          if (disposed) return;
          // `requestedSessionId` is set by the session-scoped BoardBody
          // effect. It is the first observable proof that openTabIn reached
          // the intended session surface; the controller return value alone
          // is not sufficient during reload rehydration.
          if (targetSessionId && requestedSessionId === targetSessionId) {
            if (typeof onBound === 'function') onBound();
            return;
          }
          var currentSessionId = targetSessionId || activeSessionRef.current;
          if (currentSessionId) openBoard(currentSessionId);
          if ((attempts || 0) < 120) {
            clientCtx.timeout(function () {
              retryUntilBoardBodyBinds(targetSessionId || activeSessionRef.current, (attempts || 0) + 1, onBound);
            }, 100);
          }
        }
        function openPreferred(attempts) {
          if (readLocalStorage(OPEN_PREFERENCE_KEY) !== '1') return;
          retryUntilBoardBodyBinds(activeSessionRef.current, attempts);
        }
        openPreferred(0);
        // One session-bound EventSource replaces the previous short-interval
        // XHR poll. It remains idle without HTTP responses and the host emits
        // only when a renderer asks to open this exact session's board.
        if (!sessionId || typeof EventSource !== 'function') return;
        var source = new EventSource(OPEN_EVENTS_URL + '?sessionId=' + encodeURIComponent(sessionId));
        source.addEventListener('whiteboard-open', function (event) {
          var result;
          try { result = JSON.parse(event.data || '{}'); } catch (error) { return; }
          if (!result || !result.open) return;
          var targetSessionId = result.sessionId || sessionId || null;
          retryUntilBoardBodyBinds(targetSessionId, 0, function () {
            // The host request is acknowledged only once the matching
            // session-scoped BoardBody has actually mounted.
            apiCall('wb-open-ack', { sessionId: targetSessionId }).catch(function () {});
          });
        });
        return function () { disposed = true; source.close(); };
      }, [sessionId]);
      return React.createElement('button', {
        className: 'wb-opener',
        title: 'Gemeinsames tldraw-Whiteboard in der rechten Sidebar öffnen',
        onClick: function () { rememberBoardOpen(); if (sidebarRef.open) sidebarRef.open(TYPE_KIND, sessionId); }
      }, '🧩 Board' + (ui.counts && ui.counts.notes ? ' · ' + ui.counts.notes : ''));
    }

    var WB_CSS = '.wb-view{position:relative;display:flex;flex-direction:column;height:100%;min-height:200px;font-family:inherit;}' +
      '.wb-header{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;border-bottom:1px solid rgba(128,128,128,.25);flex:0 0 auto;flex-wrap:wrap;}' +
      '.wb-header .wb-title{font-weight:600;}' +
      '.wb-header .wb-spacer{flex:1;}' +
      '.wb-counts{opacity:.72;white-space:nowrap;}' +
      // Firefox can initially resolve the sidebar tab content to zero height
      // during a page reload. Reserve a real canvas seat before the editor is
      // mounted; it may grow normally with the sidebar afterwards.
      '.wb-body{position:relative;flex:1 1 auto;min-height:240px;}' +
      '.wb-mount{position:absolute;inset:0;}' +
      '.wb-host{position:absolute;inset:0;}' +
      '.wb-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;opacity:.7;pointer-events:none;z-index:5;}' +
      '.wb-error{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;font-size:13px;padding:20px;text-align:center;z-index:6;}' +
      '.wb-panel{position:absolute;top:8px;right:8px;width:230px;max-height:70%;overflow:auto;background:rgba(20,22,28,.93);color:#eef1f6;border-radius:8px;padding:10px;font-size:12px;z-index:400;box-shadow:0 6px 20px rgba(0,0,0,.28);}' +
      '.wb-panel h4{margin:2px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;}' +
      '.wb-panel h4.wb-panel-title{margin:0 0 8px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,.15);font-size:12px;font-weight:600;text-transform:none;letter-spacing:.02em;opacity:.95;}' +
      '.wb-empty{opacity:.6;}' +
      '.wb-note-row{display:flex;gap:6px;align-items:flex-start;padding:3px 4px;border-radius:5px;cursor:pointer;line-height:1.35;}' +
      '.wb-note-row:hover{background:rgba(255,255,255,.08);}' +
      '.wb-note-text{word-break:break-word;}' +
      '.wb-badge{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:8px;border:1px solid rgba(255,255,255,.25);white-space:nowrap;}' +
      '.wb-badge-human{color:#a8e6a3;}' +
      '.wb-badge-agent{color:#c0b3ff;}' +
      '.wb-proposal{border:1px dashed rgba(150,165,255,.65);border-radius:6px;padding:6px;margin-bottom:6px;}' +
      '.wb-proposal-title{margin-bottom:4px;}' +
      '.wb-btn{font-size:11px;padding:2px 8px;border-radius:5px;border:1px solid rgba(255,255,255,.3);background:transparent;color:inherit;cursor:pointer;margin-right:4px;}' +
      '.wb-btn:hover{background:rgba(255,255,255,.12);}' +
      '.wb-actions{display:flex;flex-wrap:wrap;gap:4px;}' +
      '.wb-actions .wb-btn{margin-right:0;}' +
      '.wb-btn-primary{border-color:rgba(140,160,255,.7);background:rgba(90,110,220,.22);font-weight:600;}' +
      '.wb-btn-primary:hover{background:rgba(100,120,235,.34);}' +
      '.wb-changes{margin-top:2px;font-size:11px;opacity:.8;max-height:120px;overflow:auto;}' +
      '.wb-change-row{padding:1px 0;line-height:1.35;}' +
      '.wb-activity{margin-top:8px;border-top:1px solid rgba(255,255,255,.15);padding-top:6px;font-size:11px;opacity:.85;}' +
      '.wb-activity-row{padding:1px 0;}' +
      '.wb-opener{position:fixed;right:14px;bottom:14px;z-index:900;font-size:12px;padding:6px 10px;border-radius:999px;border:1px solid rgba(140,160,255,.55);background:rgba(20,22,28,.94);color:#eef1f6;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);}' +
      '.wb-opener:hover{background:rgba(40,44,60,.96);}';

    function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) {
        console.error('[dsh-whiteboard] slots service nicht verfügbar');
        return;
      }
      var sidebarTabs = ctx.get('sidebarRightTabs');
      var sidebarRight = ctx.get('sidebarRight');
      if (!sidebarTabs || !sidebarRight) {
        console.error('[dsh-whiteboard] sidebarRight/sidebarRightTabs nicht verfügbar — Board-Tab kann nicht registriert werden');
        return;
      }
      sidebarRef.open = function (kind, targetSessionId) {
        try {
          if (targetSessionId && typeof sidebarRight.openTabIn === 'function') sidebarRight.openTabIn(targetSessionId, kind);
          else sidebarRight.openTab(kind);
          return true;
        } catch (err) {
          // During the first shell render the controller exists before the
          // session surface does. This is an expected retry condition, not a
          // broken Whiteboard; keep other failures visible.
          if (!String(err && err.message || err).includes('no session surface is mounted')) console.error('[dsh-whiteboard] openTab fehlgeschlagen', err);
          return false;
        }
      };

      ctx.effect(function () {
        var disposers = [];
        for (var i = 0; i < CSS_URLS.length; i++) {
          var link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = CSS_URLS[i];
          document.head.appendChild(link);
          disposers.push(function (el) { return function () { el.remove(); }; }(link));
        }
        var removeCss = insertStyles(WB_CSS);
        return function () {
          removeCss();
          for (var j = 0; j < disposers.length; j++) disposers[j]();
        };
      }, 'dsh-whiteboard:css');

      // Stage one: the tab type.
      ctx.effect(function () {
        return sidebarTabs.register({
          id: TYPE_ID,
          kind: TYPE_KIND,
          priority: 'extension',
          title: function () { return '🧩 Whiteboard'; },
          guide: [{
            order: 30,
            title: function () { return '🧩 Whiteboard'; },
            description: function () { return 'Gemeinsames tldraw-Board: brainstormen, clustern, verbinden — Mensch und Agent auf derselben Fläche.'; }
          }]
        });
      }, 'dsh-whiteboard:tab-type');

      // Stage two: the tab body, keyed by the definition id.
      ctx.effect(function () {
        return slots.inject('sidebar.right.pane.tab', function () {
          return slots.register(
            { name: 'sidebar.right.pane.tab', key: TYPE_ID },
            function (props) { return BoardBody(props); }
          );
        });
      }, 'dsh-whiteboard:tab-body');

      // Floating entry point (the guide entry alone would hide the board behind the guide page).
      ctx.effect(function () {
        return slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'dsh-whiteboard-opener', order: 40, label: 'Whiteboard öffnen' },
            function (props) { return Opener(props); }
          );
        });
      }, 'dsh-whiteboard:opener');

      boardHost = document.createElement('div');
      boardHost.className = 'wb-host';
      ctx.effect(function () {
        return function () {
          try { if (boardRoot) boardRoot.unmount(); } catch (err) {}
          boardRoot = null;
          editorHolder.editor = null;
          if (boardHost && boardHost.parentNode) boardHost.parentNode.removeChild(boardHost);
        };
      }, 'board-host-lifecycle');

      var lastSelKey = '';
      var hashListener = function () { if (editorHolder.editor) navigateHash(editorHolder.editor); };
      window.addEventListener('hashchange', hashListener);
      ctx.effect(function () { return function () { window.removeEventListener('hashchange', hashListener); }; }, 'hash-navigation');
      // tldraw's rich-text handler opens links from its pointer_up event. Stop
      // only internal page references in capture phase, before tldraw sees
      // pointerdown; keyboard activation is covered by the click fallback.
      boardHost.addEventListener('pointerdown', handleInternalPagePointerDown, true);
      boardHost.addEventListener('click', handleInternalPageClick, true);
      ctx.effect(function () { return function () {
        boardHost.removeEventListener('pointerdown', handleInternalPagePointerDown, true);
        boardHost.removeEventListener('click', handleInternalPageClick, true);
      }; }, 'internal-page-links');
      var busy = false;
      var hostSessionKey = null;
      // An empty board still needs one initial snapshot so the host can
      // distinguish a live empty board from a client that is not mounted.
      var lastBoardSig = null;
      var lastDiffSnapshot = null;
      var pendingCommands = [];
      var syncScheduled = false;
      var forceSync = false;
      function syncBoard(commands, forced) {
        if (busy) return;
        var editor = editorHolder.editor;
        if (!editor) return;
        if (!serverReady) return;
        try { if (editor.getCrashingError && editor.getCrashingError()) return; } catch (err0) {}
        busy = true;
        Promise.resolve()
          .then(async function () {
            var results = [];
            var mods = loadedModules;
            for (var i = 0; i < commands.length; i++) {
              var commandId = commands[i] && commands[i].commandId ? String(commands[i].commandId) : '';
              var completedKey = commandId ? String(activeSessionId() || '') + '\u0000' + commandId : '';
              if (completedKey && completedCommandIds[completedKey]) {
                results.push({ commandId: commandId, op: commands[i].op, ok: true, replayed: true });
                continue;
              }
              try {
                await execCommand(mods, editor, commands[i]);
                if (completedKey) completedCommandIds[completedKey] = true;
                results.push({ commandId: commandId || undefined, op: commands[i].op, ok: true });
                pushActivity('🤖 Agent: ' + describeCommand(commands[i]));
              } catch (err) {
                var commandError = String(err && err.message || err);
                try { console.error('[dsh-whiteboard] command failed', commands[i] && commands[i].op, commandError, err); } catch (diagErr) {}
                results.push({ commandId: commandId || undefined, op: commands[i] && commands[i].op, ok: false, error: commandError });
                pushActivity('⚠️ Agent-Aktion fehlgeschlagen (' + (commands[i] && commands[i].op) + ')');
              }
            }
            var sel = readSelection(editor);
            var selKey = sel.map(function (x) { return x.id; }).join(',');
            var changed = lastSelKey !== selKey;
            lastSelKey = selKey;
            var snap = buildSnapshot(editor, results);
            // Auch reine Verschiebungen/Textänderungen müssen einen Snapshot auslösen,
            // sonst bleibt das Panel stumm und der Änderungs-Tracker blind.
            var boardSig = boardSignature(snap);
            var boardChanged = boardSig !== lastBoardSig || serverRetryRequested;
            lastBoardSig = boardSig;
            serverRetryRequested = false;
            var mustPush = forced || changed || boardChanged || results.length;
            if (!mustPush) return;
            if (results.length) showPanelBriefly(5000);
            if (boardChanged && lastDiffSnapshot) recordChanges(lastDiffSnapshot, snap);
            lastDiffSnapshot = snap;
            var summarySave = apiCall('wb-snapshot', Object.assign({ sessionId: activeSessionId() }, snap)).catch(function (error) {
              // The compact live summary and the durable full snapshot are
              // independent. A temporary summary-route failure must not turn
              // a successful board edit into a failed sync transaction.
              pushActivity('⚠️ Live-Snapshot fehlgeschlagen: ' + truncate(error && error.message || error, 120));
              console.error('[dsh-whiteboard] live snapshot update failed', error);
              return { ok: false, error: String(error && error.message || error) };
            });
            var persistentSave = boardChanged || results.length ? persistToServer(editor, mods, snap) : Promise.resolve();
            return Promise.all([summarySave, persistentSave]).then(function () {
              pushUi({ counts: snap.counts, notes: snap.notes, proposals: snap.proposals, selection: snap.selection });
            });
          })
          .catch(function (err) {
            // Do not let a malformed/unsupported editor snapshot silently
            // stop the sync chain; keep the host session-scoped and expose
            // the diagnostic in the existing board log.
            var message = String((err && err.message) || err || 'unbekannter Poll-Fehler');
            console.error('[dsh-whiteboard] snapshot sync failed', err);
            pushActivity('⚠️ Snapshot fehlgeschlagen: ' + truncate(message, 120));
          })
          .then(function () {
            busy = false;
            if (pendingCommands.length || forceSync) commandConsumer([], false);
          });
      }
      commandConsumer = function (commands, force) {
        if (Array.isArray(commands) && commands.length) pendingCommands = pendingCommands.concat(commands);
        if (force) forceSync = true;
        // Keep commands until the editor has hydrated and the host snapshot
        // channel is ready. The hydrate completion below schedules the drain.
        if (!editorHolder.editor || !serverReady) return;
        if (syncScheduled || busy) return;
        syncScheduled = true;
        clientCtx.timeout(function () {
          syncScheduled = false;
          var queued = pendingCommands.splice(0, pendingCommands.length);
          var forced = forceSync;
          forceSync = false;
          syncBoard(queued, forced);
        }, pendingCommands.length ? 0 : 250);
      };
      if (deferredCommandEvents.length) {
        var deferred = deferredCommandEvents.splice(0, deferredCommandEvents.length);
        commandConsumer(deferred, true);
      }
    }

    return {
      // Declared so Cordis waits for the right-Sidebar registry/controller and
      // (re-)applies this plugin once they exist — `ctx.get` alone would see
      // `undefined` if this package applies before the sidebar package.
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply: apply
    };
  }
});

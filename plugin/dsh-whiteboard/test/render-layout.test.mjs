import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

test('the generic semantic renderer fixes card typography and contains generated cards in its frame', () => {
  assert.match(client, /font: 'sans', richText: toRichText\(visibleText, href\)/);
  assert.match(client, /template === 'comparison' \|\| template === 'pro_con' \|\| template === 'cause_effect'/);
  assert.match(client, /template === 'sequence' \|\| template === 'timeline'/);
  assert.match(client, /template === 'matrix' \? 3/);
  assert.match(client, /template === 'cluster' \? 3/);
  assert.match(client, /var rowBounds = boundsUnion\(editor, rowShapes\)/);
  assert.match(client, /reparentRenderedShapesIntoFrame\(editor, freshRoot, frameChildren\)/);
  assert.match(client, /editor\.sendToBack\(\[freshRoot\.id\]\)/);
});

test('the generic semantic renderer supports bounded text shapes without turning them into notes', () => {
  assert.match(client, /shape !== 'note' && shape !== 'text'/);
  assert.match(client, /function renderStyledText\(mods, styleSpec, text, x, y, key, extraMeta, href\)/);
  assert.match(client, /type: 'text', x: x, y: y/);
  assert.match(client, /autoSize: true, richText: toRichText\(String\(text\), href\)/);
  assert.match(client, /Freitext muss neuer, nicht-leerer Text sein/);
  assert.match(client, /var layoutHeadingStyle = \{ role: 'layout-heading', shape: 'text', color: 'black', size: 'l' \}/);
});

test('generic arrow shapes never carry the invalid tldraw text prop and label with richText', () => {
  // tldraw 5.4.2 arrowShapeProps has no `text`; a label must be `richText`,
  // otherwise the whole editor.run batch fails validation atomically.
  for (const chunk of client.split("type: 'arrow'").slice(1)) {
    assert.doesNotMatch(chunk.slice(0, 400), /\btext:/, 'arrow props must not carry a text field');
  }
  assert.match(client, /if \(links\[li\]\.label\) linkProps\.richText = toRichText\(String\(links\[li\]\.label\)\)/);
  assert.match(client, /end: \{ x: step, y: 0 \}, richText: toRichText\('dann'\)/);
  assert.match(client, /if \(cmd\.label\) props\.richText = toRichText\(String\(cmd\.label\)\)/);
});

test('a render extends the board by workspace instead of wiping every renderer frame', () => {
  // Cleanup is scoped to the matching workspace on the target page, so a new
  // heading adds a frame beside existing content rather than replacing it.
  assert.doesNotMatch(client, /var renderKeys = \{ 'renderer:workspace-heading': true/);
  assert.match(client, /function workspaceIdentity\(value\)/);
  assert.match(client, /var workspaceKey = workspaceIdentity\(plan\.heading/);
  assert.match(client, /wMeta\.renderKey !== 'renderer:workspace-heading'\) continue;/);
  assert.match(client, /if \(existingKey !== workspaceKey\) continue;/);
  assert.match(client, /workspacePageId: targetPage\.id, workspaceKey: workspaceKey/);
  assert.match(client, /if \(lowestEdge > 0\) originY = lowestEdge \+ 80;/);
});

test('replacing a workspace rescues non-renderer children before the frame is deleted', () => {
  // tldraw cascades a frame delete to its children; human notes/arrows dropped
  // inside must survive, so they are reparented to the page first.
  assert.match(client, /var rescue = \[\];/);
  assert.match(client, /var rendererOwned = childMeta\.actor === 'agent' && String\(childMeta\.renderKey \|\| ''\)\.indexOf\('renderer:'\) === 0;/);
  assert.match(client, /else rescue\.push\(\{ id: all\[ci\]\.id, x: \(host\.x \|\| 0\) \+ \(all\[ci\]\.x \|\| 0\)/);
  assert.match(client, /for \(var rs = 0; rs < rescue\.length[\s\S]*parentId: targetPage\.id, x: rescue\[rs\]\.x[\s\S]*if \(detachIds\.length\) editor\.deleteShapes\(detachIds\)/);
});

test('the log auto-shows for the acting entity, never for the creator of the touched object', () => {
  const diffBody = client.match(/function diffSnapshots[\s\S]*?\n    }\n/);
  assert.ok(diffBody, 'diffSnapshots must exist');

  // The suffix describes the action that just ran, so it must be derived from
  // the passed-in flag. Deriving it from a shape's own actor/movedBy would
  // auto-show the log when a human moves a note the renderer created earlier.
  assert.match(client, /function diffSnapshots\(prev, next, actionByAgent\)/);
  assert.match(diffBody[0], /var byAgent = actionByAgent === true;/);
  assert.match(diffBody[0], /var who = byAgent \? ' \(Agent\)' : '';/);
  assert.match(diffBody[0], /var fwho = byAgent \? ' \(Agent\)' : '';/);
  assert.match(diffBody[0], /\(byAgent \? ' \(Agent\)' : ' \(Mensch\)'\)/);
  assert.doesNotMatch(diffBody[0], /movedBy/, 'diffSnapshots must not attribute via movedBy');
  assert.doesNotMatch(diffBody[0], /n\.actor === 'agent'/, 'diffSnapshots must not attribute via the note actor');

  // Auto-show hangs off that flag only.
  assert.match(client, /function recordChanges\(prev, next, actionByAgent\)/);
  assert.match(client, /var byAgent = actionByAgent === true;\n        var diffs = diffSnapshots\(prev, next, byAgent\);/);
  assert.match(client, /if \(byAgent\) showPanelBriefly\(5000\);/);

  // The sync loop counts only commands that really executed; a replayed ack
  // is not an action and must not open the log.
  assert.match(client, /var executedAgentActions = 0;/);
  assert.match(client, /results\.push\(\{ commandId: commandId, op: commands\[i\]\.op, ok: true, replayed: true \}\);\n                continue;/);
  assert.match(client, /var agentActionExecuted = executedAgentActions > 0;/);
  assert.match(client, /if \(boardChanged && lastDiffSnapshot\) recordChanges\(lastDiffSnapshot, snap, agentActionExecuted\);/);
});

test('the style panel is a human-only toggle, never an automatic one', () => {
  // The flag exists once, starts hidden (the sidebar stays lean until the
  // person asks for the bar), and is exposed to the sidebar body so the button
  // label can follow it.
  assert.match(client, /var stylePanelOpenFlag = false; \/\/ Gestaltungsleiste oben rechts; Standard ausgeblendet, der Mensch schaltet sie/);
  assert.match(client, /activity: \[\], phase: 'loading', error: '', stylePanelOpen: false \};/);

  // Exactly one writer. If an agent action or a timer could reach this name,
  // the panel would stop being manual — the same trap the log auto-show avoids.
  // Three assignments in total: the declaration, the toggle, the reset.
  const writers = client.match(/stylePanelOpenFlag = /g) || [];
  assert.equal(writers.length, 3, 'only the declaration, the toggle and the reset may assign the flag');
  assert.match(client, /function toggleStylePanel\(\) \{\n      stylePanelOpenFlag = !stylePanelOpenFlag;/);
  assert.match(client, /stylePanelOpenFlag = false;\n      styleSubs = \[\];/);
  assert.doesNotMatch(client, /stylePanelOpenFlag = true/);
  // No automatic path may reach the toggle: neither the log auto-show nor the
  // agent-action bookkeeping may mention it.
  assert.doesNotMatch(client, /showPanelBriefly[\s\S]{0,200}stylePanel/);
  assert.doesNotMatch(client, /recordChanges[\s\S]{0,300}toggleStylePanel/);

  // The switch owns the docked top-right bar only. In a narrow column there is
  // no docked bar; tldraw then renders its own compact popover from the same
  // slot, and `MobileStylePanel` returns null when the slot component is
  // missing. Returning null there would delete the only remaining route to the
  // styles, so the compact placement always delegates.
  assert.match(client, /if \(props && props\.isMobile === true\) return boardReact\.createElement\(mods\.tldraw\.DefaultStylePanel, props\);\n        if \(!state\[0\]\) return null;/);
});

test('the two header switches are icon-only and still name themselves for assistive tech', () => {
  // The header used to spend most of its width on two long German labels
  // ("🎨 Gestaltung ausblenden", "📋 Log einblenden"). The visible child is now
  // the bare icon; the words live in aria-label (accessible name) and title
  // (tooltip), so nothing is lost — only the rendered width.
  assert.match(client, /'\.wb-btn-icon\{width:24px;min-width:24px;padding:0;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;\}'/);

  const iconButtons = (client.match(/className: 'wb-btn wb-btn-icon'/g) || []).length;
  assert.equal(iconButtons, 2, 'exactly the style and log header switches are icon-only');

  assert.match(client, /'aria-label': ui\.stylePanelOpen \? 'Gestaltung ausblenden' : 'Gestaltung einblenden',/);
  assert.match(client, /'aria-label': panelVisible \? 'Log ausblenden' : 'Log einblenden',/);
  assert.match(client, /'aria-pressed': ui\.stylePanelOpen \? 'true' : 'false',/);
  assert.match(client, /'aria-pressed': panelVisible \? 'true' : 'false',/);

  // A title is a tooltip, not a name, so both words must stay in the title too.
  assert.match(client, /title: \(ui\.stylePanelOpen \? 'Gestaltung ausblenden' : 'Gestaltung einblenden'\) \+ ' — ' \+/);
  assert.match(client, /title: \(panelVisible \? 'Log ausblenden' : 'Log einblenden'\) \+ ' — ' \+/);

  // The rendered child is the icon alone: no label text may be passed after it.
  assert.match(client, /onClick: function \(\) \{ toggleStylePanel\(\); \}\n          \}, '🎨'\),/);
  assert.match(client, /onClick: function \(\) \{ panelOpenFlag = !panelVisible; panelAutoUntil = 0; pushUi\(\); \}\n          \}, '📋'\)/);

  // The explaining sentence must survive somewhere in the header.
  assert.match(client, /'Sie startet ausgeblendet und folgt allein diesem Knopf — weder Agentenaktionen noch dem Whiteboard-Log\. '/);
});

test('the style panel override never rebuilds the editor or the components object', () => {
  // tldraw 5.4.2 reads `components` through useShallowObjectIdentity and mixes
  // it into the UI context. A fresh object would be a new configuration, so the
  // object is built once per loaded runtime and only the slot's inner state
  // switches.
  assert.match(client, /var boardComponents = null;/);
  assert.match(client, /function createBoardComponents\(mods\) \{\n      if \(boardComponents\) return boardComponents;/);
  assert.match(client, /boardComponents = \{ StylePanel: BoardStylePanel \};/);
  assert.match(client, /components: createBoardComponents\(mods\),/);
  assert.match(client, /boardComponents = null;\n        return loadedModules;/);

  // The single tldraw render call must stay a single root over one host node.
  const roots = client.match(/reactDomClient\.createRoot\(/g) || [];
  assert.equal(roots.length, 2, 'one board root plus the throwaway migration root');
  assert.match(client, /boardRoot = mods\.reactDomClient\.createRoot\(boardHost\);/);
});

test('a reload keeps every renderer workspace, and only really repeated render keys are cleaned up', () => {
  // The reported symptom: after a reload, workspaces the agent had added were
  // gone. Grouping by `renderKey` alone put every renderer frame of the whole
  // document into one group, so only the newest frame survived. This test runs
  // the real reload-time normalization against snapshots, not against source
  // text, and asserts the observable outcome.
  const dedupe = loadDedupeRendererSnapshot();

  const pageA = 'page:uebersicht';
  const pageB = 'page:lernmoment';
  const frame = (id, pageId, name, key, at) => ({
    id, typeName: 'shape', type: 'frame', parentId: pageId, x: 0, y: 0, index: 'a1',
    props: { w: 1120, h: 720, name },
    meta: { actor: 'agent', actorLabel: 'DSH Whiteboard', presentationRole: 'anchor', renderKey: 'renderer:workspace-heading', at, workspacePageId: pageId, workspaceKey: key },
  });
  const card = (id, parentId, key, at) => ({
    id, typeName: 'shape', type: 'note', parentId, x: 0, y: 0, index: 'a1', props: {},
    meta: { actor: 'agent', actorLabel: 'DSH Whiteboard', renderKey: 'renderer:' + key, at },
  });
  const snapshotOf = (...records) => {
    const store = {};
    store['document:document'] = { id: 'document:document', typeName: 'document' };
    for (const record of records) store[record.id] = record;
    return { document: { store }, session: {} };
  };
  const framesOf = (snapshot) => Object.values(snapshot.document.store)
    .filter((record) => record.typeName === 'shape' && record.type === 'frame')
    .map((record) => record.props.name)
    .sort();
  const cardsOf = (snapshot) => Object.values(snapshot.document.store)
    .filter((record) => record.typeName === 'shape' && record.type !== 'frame')
    .map((record) => record.id)
    .sort();

  // 1. Two different workspaces on the same page: a reload must keep both,
  //    together with their cards.
  const twoWorkspaces = snapshotOf(
    frame('shape:f1', pageA, 'Pro & Contra', 'pro & contra', 1000),
    card('shape:c1', 'shape:f1', 'pro', 1001),
    frame('shape:f2', pageA, 'Lernmoment (Entwurf)', 'lernmoment (entwurf)', 2000),
    card('shape:c2', 'shape:f2', 'lernmoment', 2001),
  );
  const kept = dedupe(twoWorkspaces);
  assert.equal(kept.removed, 0, 'two differently titled workspaces must both survive a reload');
  assert.deepEqual(framesOf(kept.snapshot), ['Lernmoment (Entwurf)', 'Pro & Contra']);
  assert.deepEqual(cardsOf(kept.snapshot), ['shape:c1', 'shape:c2']);

  // 2. A third render extends the board; the next reload still keeps all three.
  const extended = snapshotOf(
    ...Object.values(kept.snapshot.document.store).filter((record) => record.typeName === 'shape'),
    frame('shape:f3', pageA, 'Ausblick', 'ausblick', 3000),
    card('shape:c3', 'shape:f3', 'ausblick', 3001),
  );
  const afterExtension = dedupe(extended);
  assert.equal(afterExtension.removed, 0, 'an extension must not be undone by the next reload');
  assert.deepEqual(framesOf(afterExtension.snapshot), ['Ausblick', 'Lernmoment (Entwurf)', 'Pro & Contra']);

  // 3. The same title on two different pages stays two workspaces.
  const twoPages = snapshotOf(
    frame('shape:p1', pageA, 'Erntedank', 'erntedank', 1000),
    frame('shape:p2', pageB, 'Erntedank', 'erntedank', 2000),
  );
  assert.equal(dedupe(twoPages).removed, 0, 'the page is part of a workspace identity');

  // 4. Re-rendering the very same workspace (same page, same title) is still
  //    cleaned up: exactly one frame survives, the newest.
  const rerendered = snapshotOf(
    frame('shape:old', pageA, 'Erntedank', 'erntedank', 1000),
    card('shape:oldcard', 'shape:old', 'dankbar', 1001),
    frame('shape:new', pageA, 'Erntedank', 'erntedank', 2000),
    card('shape:newcard', 'shape:new', 'dankbar', 2001),
  );
  const cleaned = dedupe(rerendered);
  assert.deepEqual(framesOf(cleaned.snapshot), ['Erntedank'], 'the older duplicate of the same workspace is removed');
  assert.deepEqual(cardsOf(cleaned.snapshot), ['shape:newcard'], 'the duplicate card of the older workspace goes with it');

  // 5. Repeated delivery of the same render key is still deduplicated inside
  //    one workspace, independent of the frame rule.
  const repeated = snapshotOf(
    frame('shape:r1', pageA, 'Erntedank', 'erntedank', 1000),
    card('shape:dup-old', 'shape:r1', 'dankbar', 1001),
    card('shape:dup-new', 'shape:r1', 'dankbar', 1002),
  );
  assert.equal(dedupe(repeated).removed, 1, 'a repeated render key must not produce a second card');
  assert.deepEqual(cardsOf(dedupe(repeated).snapshot), ['shape:dup-new']);

  // 6. The normalization must not touch human shapes at all.
  const withHumanArrow = snapshotOf(
    frame('shape:h1', pageA, 'Erntedank', 'erntedank', 1000),
    { id: 'shape:hand', typeName: 'shape', type: 'note', parentId: 'shape:h1', x: 0, y: 0, index: 'a1', props: {}, meta: {} },
    card('shape:agent-card', 'shape:h1', 'dankbar', 1001),
    frame('shape:h2', pageA, 'Erntedank', 'erntedank', 2000),
  );
  const humaneResult = dedupe(withHumanArrow);
  assert.ok(humaneResult.snapshot.document.store['shape:hand'], 'a human shape must never be removed by the renderer cleanup');

  // 7. The historical heading key of the earlier renderer names the same kind
  //    of shape and must be scoped the same way; boards migrated from the
  //    legacy store still carry it.
  const legacyKey = (id, pageId, name, at) => ({
    id, typeName: 'shape', type: 'frame', parentId: pageId, x: 0, y: 0, index: 'a1',
    props: { w: 1120, h: 720, name },
    meta: { actor: 'agent', actorLabel: 'DSH Whiteboard', renderKey: 'pts-whiteboard:workspace-heading', at },
  });
  const legacyBoard = snapshotOf(
    legacyKey('shape:l1', pageA, 'Renderer Smoke-Test', 1000),
    legacyKey('shape:l2', pageB, 'Diagnose Page-Erzeugung', 2000),
  );
  const legacyKept = dedupe(legacyBoard);
  assert.equal(legacyKept.removed, 0, 'a legacy workspace frame is a place on a page, not a document singleton');
  assert.deepEqual(framesOf(legacyKept.snapshot), ['Diagnose Page-Erzeugung', 'Renderer Smoke-Test']);

  // 8. Element keys of the renderer are per render, not per board: a second
  //    workspace legitimately carries the same `renderer:c1` element key as the
  //    first one. Scoping cards by their workspace keeps both; the plain
  //    document-wide rule would empty the older workspace on the next reload.
  const sharedElementKeys = snapshotOf(
    frame('shape:w1', pageA, 'Hoffnung – erste Ideen', 'hoffnung – erste ideen', 1000),
    card('shape:w1c1', 'shape:w1', 'c1', 1001),
    card('shape:w1c2', 'shape:w1', 'c2', 1002),
    frame('shape:w2', pageA, 'Hoffnung – weitere Ideen', 'hoffnung – weitere ideen', 2000),
    card('shape:w2c1', 'shape:w2', 'c1', 2001),
    card('shape:w2c2', 'shape:w2', 'c2', 2002),
  );
  const sharedKept = dedupe(sharedElementKeys);
  assert.equal(sharedKept.removed, 0, 'the same element key in another workspace is not a duplicate card');
  assert.deepEqual(framesOf(sharedKept.snapshot), ['Hoffnung – erste Ideen', 'Hoffnung – weitere Ideen']);
  assert.deepEqual(cardsOf(sharedKept.snapshot), ['shape:w1c1', 'shape:w1c2', 'shape:w2c1', 'shape:w2c2']);

  // 9. A genuinely re-rendered workspace still collapses to one frame — its
  //    cards collapse with it, even though the neighbouring workspace kept its
  //    own cards under the same element keys.
  const rerenderedBesideOther = snapshotOf(
    frame('shape:x1', pageA, 'Ausblick', 'ausblick', 1000),
    card('shape:x1c1', 'shape:x1', 'c1', 1001),
    frame('shape:x2', pageA, 'Ausblick', 'ausblick', 3000),
    card('shape:x2c1', 'shape:x2', 'c1', 3001),
    frame('shape:y1', pageA, 'Rückblick', 'rückblick', 2000),
    card('shape:y1c1', 'shape:y1', 'c1', 2001),
  );
  const collapsed = dedupe(rerenderedBesideOther);
  assert.deepEqual(framesOf(collapsed.snapshot), ['Ausblick', 'Rückblick'], 'only the duplicate workspace is reduced');
  assert.deepEqual(cardsOf(collapsed.snapshot), ['shape:x2c1', 'shape:y1c1'], 'the neighbouring workspace keeps its own card');
});

/** Extract the reload-time normalization from the Classic-Script client and run it. */
function loadDedupeRendererSnapshot() {
  const extract = (name) => {
    const start = client.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist in the client`);
    let depth = 0;
    for (let i = client.indexOf('{', start); i < client.length; i += 1) {
      if (client[i] === '{') depth += 1;
      else if (client[i] === '}') {
        depth -= 1;
        if (depth === 0) return client.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated body for ${name}`);
  };
  const body = [extract('normalizePageId'), extract('workspaceIdentity'), extract('isWorkspaceHeadingKey'), extract('workspaceGroupIdentity'), extract('rendererOwnerIdentity'), extract('rendererDedupeGroupKey'), extract('dedupeRendererSnapshot')].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn dedupeRendererSnapshot;`)();
}

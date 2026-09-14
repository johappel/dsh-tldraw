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

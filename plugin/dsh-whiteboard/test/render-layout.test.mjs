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

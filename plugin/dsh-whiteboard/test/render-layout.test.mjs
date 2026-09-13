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

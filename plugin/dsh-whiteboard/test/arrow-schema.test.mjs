import test from 'node:test';
import assert from 'node:assert/strict';

// Validate arrow shapes against the exact tldraw runtime the browser loads, so
// the richText fix is proven at the real schema and not only by source regex.
const { tldraw } = await import(new URL('../vendor/tldraw-runtime.mjs', import.meta.url));
const arrowDefaults = tldraw.ArrowShapeUtil.prototype.getDefaultProps.call({});
const validateArrowProps = tldraw.T.object(tldraw.arrowShapeProps);

test('the tldraw arrow schema carries richText and forbids a text prop', () => {
  assert.ok('richText' in arrowDefaults);
  assert.equal('text' in arrowDefaults, false);
  // editor.createShapes merges these defaults first, so a stray text prop is
  // the exact failure the old renderer hit: "At text: Unexpected property".
  assert.throws(() => validateArrowProps.validate({ ...arrowDefaults, text: '' }), /Unexpected property/);
});

test('a label-less divider arrow validates without a text prop', () => {
  assert.doesNotThrow(() => validateArrowProps.validate({ ...arrowDefaults }));
});

test('an arrow label validates as richText via the shared toRichText helper', () => {
  assert.doesNotThrow(() => validateArrowProps.validate({ ...arrowDefaults, richText: tldraw.toRichText('dann') }));
  assert.doesNotThrow(() => validateArrowProps.validate({ ...arrowDefaults, richText: tldraw.toRichText('führt zu') }));
});

import * as react from 'react';
import { createRoot } from 'react-dom/client';
import * as tldraw from 'tldraw';

// This module is bundled for browser delivery by build-tldraw-runtime.mjs.
// Keep React and tldraw in the same bundle: two React instances make the
// tldraw component fail with hook errors.
export { react, tldraw };
export const reactDomClient = { createRoot };

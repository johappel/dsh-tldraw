import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardIdForWorkspace,
  createSnapshotStore,
  createWorkspaceSnapshotStore,
  workspaceSnapshotPath,
} from '../lib/snapshot-store.mjs';

function temporaryDirectory(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function emptySnapshot() {
  return { store: { records: [] } };
}

test('a workspace board is stored inside that workspace and shared by its sessions', async (t) => {
  const root = temporaryDirectory('dsh-whiteboard-workspace-');
  const workspace = path.join(root, 'workspace-a');
  const board = { workspace, boardId: boardIdForWorkspace(workspace) };
  const store = createWorkspaceSnapshotStore({ legacyRoot: path.join(root, 'legacy') });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const saved = await store.save(board, 0, emptySnapshot());
  assert.equal(saved.ok, true);
  assert.equal(existsSync(workspaceSnapshotPath(workspace)), true);
  assert.equal(existsSync(path.join(root, 'legacy', `${board.boardId}.json`)), false);

  const fromAnotherSession = await store.load({ workspace, boardId: board.boardId });
  assert.equal(fromAnotherSession.version, 1);
  assert.deepEqual(fromAnotherSession.snapshot, emptySnapshot());
});

test('a legacy central snapshot migrates by copying once into the workspace', async (t) => {
  const root = temporaryDirectory('dsh-whiteboard-migration-');
  const workspace = path.join(root, 'workspace-a');
  const board = { workspace, boardId: boardIdForWorkspace(workspace) };
  const legacyRoot = path.join(root, 'legacy');
  const legacy = createSnapshotStore({ root: legacyRoot });
  const store = createWorkspaceSnapshotStore({ legacyRoot });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal((await legacy.save(board.boardId, 0, emptySnapshot())).ok, true);
  const migrated = await store.load(board);

  assert.equal(migrated.version, 1);
  assert.equal(existsSync(workspaceSnapshotPath(workspace)), true);
  assert.equal(existsSync(path.join(legacyRoot, `${board.boardId}.json`)), true);
});

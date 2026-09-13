import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_SCHEMA_VERSION = 1;

function normalizedWorkspace(workspace) {
  const resolved = path.resolve(String(workspace || process.cwd()));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * A stable, opaque board identity for one DSH workspace.
 * The workspace path is deliberately not stored in the board file name.
 */
export function boardIdForWorkspace(workspace) {
  const digest = createHash('sha256')
    .update(`dsh-whiteboard\0${normalizedWorkspace(workspace)}`)
    .digest('hex');
  return `workspace-${digest.slice(0, 32)}`;
}

function validBoardId(boardId) {
  return /^workspace-[a-f0-9]{32}$/.test(String(boardId || ''));
}

function validSnapshot(snapshot) {
  return Boolean(
    snapshot &&
    typeof snapshot === 'object' &&
    ((snapshot.store && typeof snapshot.store === 'object') ||
      (snapshot.document && typeof snapshot.document === 'object' && snapshot.document.store && typeof snapshot.document.store === 'object'))
  );
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8');
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    // Windows does not replace an existing destination for every rename mode.
    // copyFile keeps the store recoverable even on that fallback path.
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    await fs.copyFile(temporaryPath, filePath);
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function readSnapshotRecord(filePath, boardId) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const record = JSON.parse(raw);
    if (record?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || record?.boardId !== boardId || !validSnapshot(record.snapshot)) {
      throw new Error('ungültiges Whiteboard-Snapshot-Format');
    }
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      boardId,
      version: Number.isInteger(record.version) && record.version >= 1 ? record.version : 1,
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : null,
      snapshot: record.snapshot
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function workspaceSnapshotPath(workspace) {
  const workspaceRoot = path.resolve(String(workspace || ''));
  if (!workspace || workspaceRoot === path.parse(workspaceRoot).root) {
    throw new Error('gültiger Workspace für das Whiteboard erforderlich');
  }
  return path.join(workspaceRoot, '.dsh-whiteboard', 'snapshot.json');
}

export function createSnapshotStore({ root }) {
  const storageRoot = path.resolve(String(root || path.join(process.cwd(), 'whiteboard-snapshots')));
  let ready;
  let writeChain = Promise.resolve();

  function filePath(boardId) {
    if (!validBoardId(boardId)) throw new Error('ungültige Whiteboard-ID');
    return path.join(storageRoot, `${boardId}.json`);
  }

  async function ensureRoot() {
    if (!ready) ready = fs.mkdir(storageRoot, { recursive: true });
    await ready;
  }

  async function load(boardId) {
    await ensureRoot();
    return readSnapshotRecord(filePath(boardId), boardId);
  }

  async function save(boardId, expectedVersion, snapshot) {
    if (!validSnapshot(snapshot)) throw new Error('ungültiger tldraw-Snapshot');
    const operation = writeChain.then(async () => {
      const current = await load(boardId);
      const actualVersion = current?.version || 0;
      if (expectedVersion !== actualVersion) {
        return {
          ok: false,
          conflict: true,
          boardId,
          version: actualVersion,
          savedAt: current?.savedAt || null,
          snapshot: current?.snapshot || null
        };
      }

      const next = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        boardId,
        version: actualVersion + 1,
        savedAt: new Date().toISOString(),
        snapshot
      };
      await ensureRoot();
      await writeJsonAtomically(filePath(boardId), next);
      return { ok: true, boardId, version: next.version, savedAt: next.savedAt };
    });
    writeChain = operation.catch(() => {});
    return operation;
  }

  return { root: storageRoot, load, save };
}

/**
 * Workspace-local durable snapshots. The browser receives only a board ID;
 * the trusted DSH session context supplies the workspace path to this store.
 * A legacy central snapshot is copied once on first read and deliberately kept
 * as a recoverable migration source.
 */
export function createWorkspaceSnapshotStore({ legacyRoot } = {}) {
  const legacyStorageRoot = path.resolve(String(legacyRoot || path.join(process.cwd(), 'whiteboard-snapshots')));
  const writeChains = new Map();

  function location(board) {
    if (!board || !validBoardId(board.boardId)) throw new Error('ungültige Whiteboard-ID');
    const workspace = path.resolve(String(board.workspace || ''));
    return {
      boardId: board.boardId,
      workspace,
      filePath: workspaceSnapshotPath(workspace),
      legacyFilePath: path.join(legacyStorageRoot, `${board.boardId}.json`)
    };
  }

  async function load(board) {
    const target = location(board);
    const local = await readSnapshotRecord(target.filePath, target.boardId);
    if (local) return local;

    const legacy = await readSnapshotRecord(target.legacyFilePath, target.boardId);
    if (!legacy) return null;
    await fs.mkdir(path.dirname(target.filePath), { recursive: true });
    await writeJsonAtomically(target.filePath, legacy);
    return legacy;
  }

  async function save(board, expectedVersion, snapshot) {
    if (!validSnapshot(snapshot)) throw new Error('ungültiger tldraw-Snapshot');
    const target = location(board);
    const prior = writeChains.get(target.filePath) || Promise.resolve();
    const operation = prior.then(async () => {
      const current = await load(board);
      const actualVersion = current?.version || 0;
      if (expectedVersion !== actualVersion) {
        return {
          ok: false,
          conflict: true,
          boardId: target.boardId,
          version: actualVersion,
          savedAt: current?.savedAt || null,
          snapshot: current?.snapshot || null
        };
      }
      const next = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        boardId: target.boardId,
        version: actualVersion + 1,
        savedAt: new Date().toISOString(),
        snapshot
      };
      await fs.mkdir(path.dirname(target.filePath), { recursive: true });
      await writeJsonAtomically(target.filePath, next);
      return { ok: true, boardId: target.boardId, version: next.version, savedAt: next.savedAt };
    });
    writeChains.set(target.filePath, operation.catch(() => {}));
    return operation;
  }

  return { legacyRoot: legacyStorageRoot, load, save, workspaceSnapshotPath };
}

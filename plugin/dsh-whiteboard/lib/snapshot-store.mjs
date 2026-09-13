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
    try {
      const raw = await fs.readFile(filePath(boardId), 'utf8');
      const record = JSON.parse(raw);
      if (record?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || record?.boardId !== boardId || !validSnapshot(record.snapshot)) {
        throw new Error('ungültiges Whiteboard-Snapshot-Format');
      }
      return {
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

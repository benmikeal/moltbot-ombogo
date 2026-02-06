import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
  filesBackedUp?: number;
}

/**
 * List of paths to backup from the container.
 * Each path will be backed up to R2 with its relative path preserved.
 */
const BACKUP_PATHS = [
  '/root/.clawdbot/',  // Main config directory
  '/root/clawd/skills/', // Skills directory
];

/**
 * Files to exclude from backup (by suffix)
 */
const EXCLUDE_SUFFIXES = ['.lock', '.log', '.tmp'];

/**
 * Read a file from the container and return its contents as a buffer
 */
async function readFileFromContainer(
  sandbox: Sandbox,
  filePath: string
): Promise<{ data: Uint8Array; error?: string }> {
  try {
    // Use base64 encoding to safely transfer binary data
    const proc = await sandbox.startProcess(`base64 "${filePath}" 2>/dev/null || echo "FILE_NOT_FOUND"`);
    await waitForProcess(proc, 10000);
    const logs = await proc.getLogs();
    const output = logs.stdout?.trim() || '';

    if (output === 'FILE_NOT_FOUND' || !output) {
      return { data: new Uint8Array(), error: 'File not found' };
    }

    // Decode base64 to binary
    const binaryString = atob(output);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return { data: bytes };
  } catch (err) {
    return {
      data: new Uint8Array(),
      error: err instanceof Error ? err.message : 'Unknown error'
    };
  }
}

/**
 * List files in a directory inside the container
 */
async function listFilesInContainer(
  sandbox: Sandbox,
  dirPath: string
): Promise<string[]> {
  try {
    // Use find to list all files recursively, output relative paths
    const proc = await sandbox.startProcess(
      `find "${dirPath}" -type f 2>/dev/null | sort`
    );
    await waitForProcess(proc, 15000);
    const logs = await proc.getLogs();
    const output = logs.stdout?.trim() || '';

    if (!output) return [];

    return output.split('\n').filter(f => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Helper to run a sandbox command with retry on DO reset errors
 */
async function runWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  delayMs = 3000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only retry on DO reset errors
      if (!lastError.message.includes('Durable Object reset')) {
        throw lastError;
      }
      console.log(`DO reset on attempt ${attempt + 1}, retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/**
 * Sync moltbot config from container to R2 using direct R2 API.
 *
 * This function:
 * 1. Lists files in the container config directories
 * 2. Reads each file and uploads to R2 using the bucket binding
 * 3. Writes a timestamp for tracking
 *
 * This approach doesn't require s3fs mounting - it uses the native R2 binding.
 */
export async function syncToR2Direct(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<SyncResult> {
  // Check if R2 bucket binding is available
  if (!env.MOLTBOT_BUCKET) {
    return { success: false, error: 'R2 bucket binding not configured' };
  }

  // Check if there's an existing backup - if not, skip sanity check (first backup)
  const existingBackup = await getLastSyncDirect(env);

  // Sanity check: verify source has critical files before syncing
  // Skip this check for first backup (when no existing backup exists)
  // If check fails due to DO reset, continue anyway (non-blocking)
  if (existingBackup) {
    try {
      const checkProc = await runWithRetry(() =>
        sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json && echo "ok"')
      );
      await waitForProcess(checkProc, 5000);
      const checkLogs = await checkProc.getLogs();
      if (!checkLogs.stdout?.includes('ok')) {
        return {
          success: false,
          error: 'Sync aborted: source missing clawdbot.json',
          details: 'The local config directory is missing critical files.',
        };
      }
    } catch (err) {
      // Log warning but continue - DO reset errors during deployment are transient
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.warn('Sanity check failed, continuing anyway:', errMsg);
    }
  }

  let filesBackedUp = 0;
  const errors: string[] = [];

  // Process each backup path
  for (const basePath of BACKUP_PATHS) {
    let files: string[];
    try {
      files = await runWithRetry(() => listFilesInContainer(sandbox, basePath));
    } catch {
      console.log(`Skipping ${basePath} due to errors`);
      continue;
    }

    for (const filePath of files) {
      // Skip excluded files
      if (EXCLUDE_SUFFIXES.some(suffix => filePath.endsWith(suffix))) {
        continue;
      }

      // Calculate R2 key - preserve directory structure
      // e.g., /root/.clawdbot/config.json -> clawdbot/config.json
      const r2Key = filePath
        .replace('/root/.clawdbot/', 'clawdbot/')
        .replace('/root/clawd/skills/', 'skills/');

      // Read file from container with retry
      let data: Uint8Array;
      try {
        const result = await runWithRetry(() => readFileFromContainer(sandbox, filePath));
        if (result.error) {
          errors.push(`${filePath}: ${result.error}`);
          continue;
        }
        data = result.data;
      } catch (err) {
        errors.push(`${filePath}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        continue;
      }

      // Upload to R2
      try {
        await env.MOLTBOT_BUCKET.put(r2Key, data);
        filesBackedUp++;
      } catch (uploadErr) {
        errors.push(`${filePath}: Upload failed - ${uploadErr}`);
      }
    }
  }

  // Write timestamp
  const timestamp = new Date().toISOString();
  try {
    await env.MOLTBOT_BUCKET.put('.last-sync', timestamp);
  } catch {
    // Non-fatal
  }

  if (filesBackedUp === 0 && errors.length > 0) {
    return {
      success: false,
      error: 'Sync failed',
      details: errors.join('; '),
    };
  }

  return {
    success: true,
    lastSync: timestamp,
    filesBackedUp,
    details: errors.length > 0 ? `${errors.length} errors: ${errors.slice(0, 3).join('; ')}` : undefined,
  };
}

/**
 * Restore moltbot config from R2 to container using direct R2 API.
 */
export async function restoreFromR2Direct(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<SyncResult> {
  if (!env.MOLTBOT_BUCKET) {
    return { success: false, error: 'R2 bucket binding not configured' };
  }

  let filesRestored = 0;
  const errors: string[] = [];

  // List all objects in R2
  const listed = await env.MOLTBOT_BUCKET.list();

  for (const object of listed.objects) {
    // Skip timestamp file
    if (object.key === '.last-sync') continue;

    // Calculate container path from R2 key
    let containerPath: string;
    if (object.key.startsWith('clawdbot/')) {
      containerPath = `/root/.clawdbot/${object.key.slice(9)}`;
    } else if (object.key.startsWith('skills/')) {
      containerPath = `/root/clawd/skills/${object.key.slice(7)}`;
    } else {
      continue; // Unknown prefix, skip
    }

    try {
      // Get object from R2
      const r2Object = await env.MOLTBOT_BUCKET.get(object.key);
      if (!r2Object) continue;

      const data = await r2Object.arrayBuffer();
      const base64Data = btoa(String.fromCharCode(...new Uint8Array(data)));

      // Ensure parent directory exists
      const parentDir = containerPath.substring(0, containerPath.lastIndexOf('/'));
      await sandbox.startProcess(`mkdir -p "${parentDir}"`);

      // Write file to container using base64 decode
      const writeProc = await sandbox.startProcess(
        `echo "${base64Data}" | base64 -d > "${containerPath}"`
      );
      await waitForProcess(writeProc, 10000);
      filesRestored++;
    } catch (err) {
      errors.push(`${object.key}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  return {
    success: filesRestored > 0,
    filesBackedUp: filesRestored,
    details: errors.length > 0 ? `${errors.length} errors` : undefined,
  };
}

/**
 * Get last sync timestamp from R2
 */
export async function getLastSyncDirect(env: MoltbotEnv): Promise<string | null> {
  if (!env.MOLTBOT_BUCKET) return null;

  try {
    const obj = await env.MOLTBOT_BUCKET.get('.last-sync');
    if (!obj) return null;
    return await obj.text();
  } catch {
    return null;
  }
}

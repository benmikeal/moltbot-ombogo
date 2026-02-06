import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, R2_BUCKET_NAME } from '../config';

/**
 * Check if R2 is already mounted by looking at the mount table
 */
async function isR2Mounted(sandbox: Sandbox): Promise<boolean> {
  try {
    const proc = await sandbox.startProcess(`mount | grep "s3fs on ${R2_MOUNT_PATH}"`);
    // Wait for the command to complete
    let attempts = 0;
    while (proc.status === 'running' && attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    const logs = await proc.getLogs();
    // If stdout has content, the mount exists
    const mounted = !!(logs.stdout && logs.stdout.includes('s3fs'));
    console.log('isR2Mounted check:', mounted, 'stdout:', logs.stdout?.slice(0, 100));
    return mounted;
  } catch (err) {
    console.log('isR2Mounted error:', err);
    return false;
  }
}

/**
 * Mount R2 bucket for persistent storage
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    const missing: string[] = [];
    if (!env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
    if (!env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
    if (!env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');
    console.log('R2 storage not configured - missing secrets:', missing.join(', '));
    return false;
  }

  // Validate CF_ACCOUNT_ID format (should be 32-char hex string)
  const accountIdValid = /^[a-f0-9]{32}$/i.test(env.CF_ACCOUNT_ID);
  if (!accountIdValid) {
    console.error('CF_ACCOUNT_ID format invalid - expected 32-char hex string, got:',
      env.CF_ACCOUNT_ID.length, 'chars starting with:', env.CF_ACCOUNT_ID.slice(0, 8) + '...');
    return false;
  }

  // Check if already mounted first - this avoids errors and is faster
  if (await isR2Mounted(sandbox)) {
    console.log('R2 bucket already mounted at', R2_MOUNT_PATH);
    return true;
  }

  try {
    console.log('Mounting R2 bucket at', R2_MOUNT_PATH);
    await sandbox.mountBucket(R2_BUCKET_NAME, R2_MOUNT_PATH, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      // Pass credentials explicitly since we use R2_* naming instead of AWS_*
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('R2 bucket mounted successfully - moltbot data will persist across sessions');
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const endpoint = `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    console.log('R2 mount error:', errorMessage);
    console.log('R2 mount details - bucket:', R2_BUCKET_NAME, 'endpoint:', endpoint);

    // Common error diagnosis
    if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      console.error('R2 AUTH ERROR: Access denied. Check that R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are valid and have read/write permissions on bucket:', R2_BUCKET_NAME);
    } else if (errorMessage.includes('404') || errorMessage.includes('NoSuchBucket')) {
      console.error('R2 BUCKET ERROR: Bucket not found. Verify bucket "moltbot-data" exists in your R2 console.');
    } else if (errorMessage.includes('InvalidAccessKeyId')) {
      console.error('R2 KEY ERROR: Invalid access key. The R2_ACCESS_KEY_ID may have been deleted or regenerated.');
    }

    // Check again if it's mounted - the error might be misleading
    if (await isR2Mounted(sandbox)) {
      console.log('R2 bucket is mounted despite error');
      return true;
    }

    // Don't fail if mounting fails - moltbot can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}

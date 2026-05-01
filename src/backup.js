// ═══════════════════════════════════════════════════════════════════════════
// src/backup.js — Phase 2 finalization: automated DB backups to S3-compatible
// object storage.
//
// Plan reference (docs/saas-conversion-plan.md, "Cross-cutting → Backups"):
//
//     SaaS requirement: Once paying customers exist, weekly automated
//     `pg_dump` to S3 or Backblaze. Quarterly restore drill.
//
// Design choices:
//
//   * Streamed `pg_dump --format=custom` to the S3 multipart uploader. No
//     intermediate file on disk — Railway containers have ephemeral
//     filesystems and a deploy mid-upload would orphan a partial dump.
//
//   * S3-compatible: works against AWS S3, Backblaze B2 (via S3 endpoint),
//     Cloudflare R2, or DigitalOcean Spaces. Operator picks via
//     BACKUP_S3_ENDPOINT (R2/B2) or omits it (default AWS).
//
//   * Boot-time scheduler: start a single setInterval to run on a 7-day
//     cadence (configurable via BACKUP_INTERVAL_HOURS for testing). First
//     run is delayed 5 minutes from boot so a deploy storm doesn't all
//     fire at the same wall-clock minute.
//
//   * Env-gated: only activates when BACKUP_S3_BUCKET is set. Without it,
//     scheduleBackups() is a no-op and no AWS SDK code runs.
//
//   * Custom format (`-Fc`): smaller than plain SQL, restorable via
//     `pg_restore`, supports parallel restore. Plain `--format=plain` is
//     bigger and slower to restore at scale.
//
//   * No retention pruning here — let the bucket's lifecycle policy handle
//     it (S3 / R2 / B2 all have native object-expiration rules; cheaper
//     than us iterating to delete). Document the policy in the operator
//     runbook, not in code.
//
// Required env (when enabled):
//   BACKUP_S3_BUCKET            — bucket name
//   BACKUP_S3_ACCESS_KEY_ID
//   BACKUP_S3_SECRET_ACCESS_KEY
//
// Optional env:
//   BACKUP_S3_REGION            — default 'us-east-1'
//   BACKUP_S3_ENDPOINT          — for R2/B2/Spaces (e.g. https://<acct>.r2.cloudflarestorage.com)
//   BACKUP_S3_FORCE_PATH_STYLE  — 'true' for R2/B2 (default false)
//   BACKUP_S3_KEY_PREFIX        — folder/prefix inside the bucket; default 'oculah-backups'
//   BACKUP_INTERVAL_HOURS       — cadence; default 168 (weekly)
//   BACKUP_FIRST_DELAY_MS       — first-run delay; default 5 min
// ═══════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const { URL } = require('url');

let _scheduled = false;

function _isEnabled() {
  return !!process.env.BACKUP_S3_BUCKET;
}

function _backupKey(prefix) {
  const now = new Date();
  const ts  = now.toISOString().replace(/[:.]/g, '-');  // 2026-05-01T12-34-56-789Z
  return `${prefix}/oculah-${ts}.dump`;
}

/**
 * Stream `pg_dump --format=custom` directly into an S3 multipart upload.
 * Returns { ok: true, key, bytes } on success. Throws on failure.
 */
async function runOneBackup() {
  if (!_isEnabled()) return { ok: false, reason: 'BACKUP_S3_BUCKET not set' };
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for backup');

  const { S3Client } = require('@aws-sdk/client-s3');
  const { Upload }   = require('@aws-sdk/lib-storage');

  const region   = process.env.BACKUP_S3_REGION || 'us-east-1';
  const endpoint = process.env.BACKUP_S3_ENDPOINT || undefined;
  const forcePathStyle = String(process.env.BACKUP_S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';
  const prefix   = process.env.BACKUP_S3_KEY_PREFIX || 'oculah-backups';
  const bucket   = process.env.BACKUP_S3_BUCKET;
  const key      = _backupKey(prefix);

  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId:     process.env.BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
    },
  });

  // Spawn pg_dump. The custom format (-Fc) is binary, smaller than plain
  // SQL, and restorable in parallel via pg_restore -j N. We pipe its
  // stdout straight into the multipart upload — no temp file.
  const dump = spawn('pg_dump', [
    '--format=custom',
    '--no-owner',                 // restore-friendly: don't tie objects to a specific role
    '--no-privileges',            // ditto for grants
    '--compress=9',
    '--dbname', process.env.DATABASE_URL,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Surface pg_dump's stderr in our logs without buffering all of it
  // (stderr can be chatty on large dumps). Just stream through.
  dump.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    // Filter out the noisy "creating archive" lines, keep warnings/errors.
    if (/error|warning|fatal/i.test(s)) console.warn('[backup pg_dump]', s.trim());
  });

  let bytes = 0;
  dump.stdout.on('data', (chunk) => { bytes += chunk.length; });

  const startedAt = Date.now();
  console.log(`[backup] starting pg_dump → s3://${bucket}/${key}`);

  // Drive the upload + capture pg_dump's exit code in parallel.
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: dump.stdout, ContentType: 'application/octet-stream' },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,    // 16 MB parts — typical sweet spot
  });

  const dumpExit = new Promise((resolve, reject) => {
    dump.on('error', reject);
    dump.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited with code ${code}`));
    });
  });

  try {
    // Race-but-await both: if pg_dump errors we want to abort the upload;
    // if upload errors we want to log and rethrow.
    await Promise.all([upload.done(), dumpExit]);
    const secs = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[backup] OK ${(bytes / 1024 / 1024).toFixed(1)}MB in ${secs}s → s3://${bucket}/${key}`);
    return { ok: true, key, bytes };
  } catch (e) {
    console.error('[backup] FAILED:', e.message);
    try { dump.kill('SIGTERM'); } catch (_) {}
    throw e;
  }
}

/**
 * Boot-time scheduler. Idempotent — calling it twice in the same process
 * is a no-op (guarded by _scheduled). Safe to call from server.js boot
 * regardless of env: when BACKUP_S3_BUCKET isn't set, this immediately
 * returns and never imports the AWS SDK.
 */
function scheduleBackups() {
  if (_scheduled) return;
  if (!_isEnabled()) {
    console.log('[backup] disabled — set BACKUP_S3_BUCKET to enable weekly pg_dump → S3');
    return;
  }
  _scheduled = true;

  const intervalHours = Math.max(1, parseInt(process.env.BACKUP_INTERVAL_HOURS, 10) || 168);
  const firstDelayMs  = Math.max(0, parseInt(process.env.BACKUP_FIRST_DELAY_MS, 10) || 5 * 60 * 1000);

  console.log(`[backup] scheduled — first run in ${Math.round(firstDelayMs / 60000)}min, then every ${intervalHours}h`);

  const tick = () => {
    runOneBackup().catch((e) => {
      // Already logged by runOneBackup; swallow so the interval keeps firing.
      console.error('[backup] scheduled run failed:', e.message);
    });
  };

  setTimeout(() => {
    tick();
    setInterval(tick, intervalHours * 60 * 60 * 1000);
  }, firstDelayMs);
}

module.exports = { runOneBackup, scheduleBackups };

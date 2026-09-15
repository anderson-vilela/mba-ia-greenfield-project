import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.QUEUE_HOST || 'valkey',
  port: parseInt(process.env.QUEUE_PORT || '6379', 10),
  // Namespaces every BullMQ key. Tests override it (see src/test/jest-env-setup.ts)
  // so the video-worker container never sees a job produced by a suite.
  prefix: process.env.QUEUE_PREFIX || 'bull',
  sweepAbandonedUploadsIntervalMs: parseInt(
    process.env.QUEUE_SWEEP_ABANDONED_UPLOADS_INTERVAL_MS || '3600000',
    10,
  ),
}));

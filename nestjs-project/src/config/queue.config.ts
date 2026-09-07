import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.QUEUE_HOST || 'valkey',
  port: parseInt(process.env.QUEUE_PORT || '6379', 10),
  sweepAbandonedUploadsIntervalMs: parseInt(
    process.env.QUEUE_SWEEP_ABANDONED_UPLOADS_INTERVAL_MS || '3600000',
    10,
  ),
}));

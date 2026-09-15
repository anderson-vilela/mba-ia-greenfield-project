import { Queue } from 'bullmq';

const VIDEO_PROCESSING_QUEUE = 'video-processing';

function createQueueConnection() {
  return {
    host: process.env.QUEUE_HOST ?? 'valkey',
    port: Number(process.env.QUEUE_PORT ?? 6379),
  };
}

export async function clearVideoProcessingQueue(): Promise<void> {
  const queue = new Queue(VIDEO_PROCESSING_QUEUE, {
    connection: createQueueConnection(),
    // Must match the prefix the app under test uses, so the suite only ever
    // obliterates its own namespace — never the dev worker's queue (TD-13).
    prefix: process.env.QUEUE_PREFIX ?? 'bull',
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

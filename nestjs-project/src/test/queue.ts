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
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

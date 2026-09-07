import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

describe('QueueModule', () => {
  const compile = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

  it('should compile successfully and inject the video-processing queue', async () => {
    const module = await compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);

    await module.close();
  }, 15000);

  it('should apply default retry options (3 attempts, exponential backoff) to jobs added without explicit options', async () => {
    const module = await compile();
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    const job = await queue.add('test-job', {});
    try {
      expect(job.opts.attempts).toBe(3);
      expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
    } finally {
      await job.remove().catch(() => {});
      await module.close();
    }
  }, 15000);
});

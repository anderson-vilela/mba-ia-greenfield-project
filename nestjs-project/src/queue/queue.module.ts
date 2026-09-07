import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import {
  SWEEP_ABANDONED_UPLOADS_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    }),
    BullModule.registerQueue({
      name: SWEEP_ABANDONED_UPLOADS_QUEUE,
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}

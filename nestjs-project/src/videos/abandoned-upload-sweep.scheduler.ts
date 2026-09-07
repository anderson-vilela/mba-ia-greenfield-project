import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  SWEEP_ABANDONED_UPLOADS_JOB,
  SWEEP_ABANDONED_UPLOADS_QUEUE,
} from '../queue/queue.constants';

@Injectable()
export class AbandonedUploadSweepScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(SWEEP_ABANDONED_UPLOADS_QUEUE)
    private readonly sweepQueue: Queue,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sweepQueue.upsertJobScheduler(
      SWEEP_ABANDONED_UPLOADS_JOB,
      { every: this.config.sweepAbandonedUploadsIntervalMs },
      {
        name: SWEEP_ABANDONED_UPLOADS_JOB,
        data: {},
      },
    );
  }
}

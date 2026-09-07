import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { SWEEP_ABANDONED_UPLOADS_QUEUE } from '../queue/queue.constants';
import { STORAGE_CONTENT_TYPE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';

const ABANDONED_UPLOAD_FAILURE_REASON = 'Upload expired before completion';

@Processor(SWEEP_ABANDONED_UPLOADS_QUEUE)
export class AbandonedUploadSweepProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const expiredDrafts = await this.videoRepository.find({
      where: { status: 'draft', upload_expires_at: LessThan(new Date()) },
    });

    for (const video of expiredDrafts) {
      await this.sweepVideo(video);
    }
  }

  private async sweepVideo(video: Video): Promise<void> {
    if (video.upload_id) {
      const bucket = this.storageService.resolveBucket(
        STORAGE_CONTENT_TYPE.VIDEO,
      );
      await this.storageService.abortMultipartUpload(
        bucket,
        video.original_key,
        video.upload_id,
      );
    }

    await this.videoRepository.update(
      { id: video.id, status: 'draft' },
      {
        status: 'failed',
        failure_reason: ABANDONED_UPLOAD_FAILURE_REASON,
        upload_id: null,
      },
    );
  }
}

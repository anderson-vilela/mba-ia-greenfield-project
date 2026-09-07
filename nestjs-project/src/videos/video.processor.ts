import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { STORAGE_CONTENT_TYPE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';

const THUMBNAIL_POSITION_RATIO = 0.1;

interface FfprobeFormatOutput {
  format?: { duration?: string };
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    super();
  }

  async process(job: Job<{ videoId: string }>): Promise<void> {
    try {
      await this.processVideo(job.data.videoId);
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      const isLastAttempt = job.attemptsMade + 1 >= attempts;

      if (isLastAttempt) {
        await this.videoRepository.update(
          { id: job.data.videoId, status: 'processing' },
          {
            status: 'failed',
            failure_reason:
              error instanceof Error ? error.message : String(error),
          },
        );
      }

      throw error;
    }
  }

  private async processVideo(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== 'processing') {
      return;
    }

    const videoBucket = this.storageService.resolveBucket(
      STORAGE_CONTENT_TYPE.VIDEO,
    );
    const sourceUrl = await this.storageService.presignGetObject(
      videoBucket,
      video.original_key,
      { ttlSeconds: this.config.presignedDownloadUrlTtlSeconds },
    );

    const probeOutput = await this.ffmpegService.probe(sourceUrl);
    const durationSeconds = this.parseDurationSeconds(probeOutput);
    const thumbnailTimestampSeconds =
      durationSeconds * THUMBNAIL_POSITION_RATIO;

    const thumbnailBuffer = await this.ffmpegService.extractThumbnail(
      sourceUrl,
      thumbnailTimestampSeconds,
    );
    const thumbnailKey = `${video.id}/thumbnail.jpg`;
    const thumbnailBucket = this.storageService.resolveBucket(
      STORAGE_CONTENT_TYPE.THUMBNAIL,
    );
    await this.storageService.putObject(
      thumbnailBucket,
      thumbnailKey,
      thumbnailBuffer,
      'image/jpeg',
    );

    await this.videoRepository.update(
      { id: video.id, status: 'processing' },
      {
        status: 'ready',
        duration_seconds: Math.round(durationSeconds),
        thumbnail_key: thumbnailKey,
      },
    );
  }

  private parseDurationSeconds(rawProbeOutput: string): number {
    const parsed = JSON.parse(rawProbeOutput) as FfprobeFormatOutput;
    const duration = Number(parsed.format?.duration);

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('ffprobe did not return a valid duration');
    }

    return duration;
  }
}

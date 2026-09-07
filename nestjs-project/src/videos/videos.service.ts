import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { STORAGE_CONTENT_TYPE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { generateVideoPublicId } from './public-id.util';
import {
  UnsupportedMediaTypeException,
  UploadFileTooLargeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoUploadAlreadyCompletedException,
} from './videos.exceptions';

export interface InitiateUploadPart {
  part_number: number;
  url: string;
}

export interface InitiateUploadResult {
  id: string;
  public_id: string;
  upload_id: string;
  parts: InitiateUploadPart[];
}

export interface CompleteUploadResult {
  id: string;
  status: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (dto.file_size > this.config.maxUploadSizeBytes) {
      throw new UploadFileTooLargeException();
    }
    if (!this.config.acceptedMimeTypes.includes(dto.content_type)) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }

    const videoId = randomUUID();
    const originalKey = `${videoId}/${dto.filename}`;
    const bucket = this.storageService.resolveBucket(
      STORAGE_CONTENT_TYPE.VIDEO,
    );
    const uploadId = await this.storageService.createMultipartUpload(
      bucket,
      originalKey,
      dto.content_type,
    );
    const partCount = Math.max(
      1,
      Math.ceil(dto.file_size / this.config.multipartPartSizeBytes),
    );
    const urls = await this.storageService.presignUploadParts(
      bucket,
      originalKey,
      uploadId,
      partCount,
    );

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        id: videoId,
        public_id: generateVideoPublicId(),
        channel_id: channel.id,
        title: dto.filename,
        original_key: originalKey,
        upload_id: uploadId,
        upload_expires_at: new Date(
          Date.now() + this.config.uploadAbandonedTtlSeconds * 1000,
        ),
      }),
    );

    return {
      id: video.id,
      public_id: video.public_id,
      upload_id: uploadId,
      parts: urls.map((url, index) => ({ part_number: index + 1, url })),
    };
  }

  async completeUpload(
    videoId: string,
    userId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || video.channel_id !== channel.id) {
      throw new VideoAccessDeniedException();
    }

    if (video.status !== 'draft') {
      throw new VideoUploadAlreadyCompletedException();
    }

    const bucket = this.storageService.resolveBucket(
      STORAGE_CONTENT_TYPE.VIDEO,
    );
    await this.storageService.completeMultipartUpload(
      bucket,
      video.original_key,
      video.upload_id!,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        eTag: part.etag,
      })),
    );

    const updateResult = await this.videoRepository.update(
      { id: videoId, status: 'draft' },
      { status: 'processing', upload_id: null },
    );
    if (updateResult.affected === 0) {
      throw new VideoUploadAlreadyCompletedException();
    }

    await this.videoProcessingQueue.add('process-video', { videoId });

    return { id: videoId, status: 'processing' };
  }

  async getStreamUrl(videoId: string): Promise<string> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== 'ready') {
      throw new VideoNotReadyException();
    }

    const bucket = this.storageService.resolveBucket(
      STORAGE_CONTENT_TYPE.VIDEO,
    );
    return this.storageService.presignGetObject(bucket, video.original_key, {
      ttlSeconds: this.config.presignedStreamUrlTtlSeconds,
    });
  }

  async getDownloadUrl(videoId: string): Promise<string> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== 'ready') {
      throw new VideoNotReadyException();
    }

    const bucket = this.storageService.resolveBucket(
      STORAGE_CONTENT_TYPE.VIDEO,
    );
    return this.storageService.presignGetObject(bucket, video.original_key, {
      ttlSeconds: this.config.presignedDownloadUrlTtlSeconds,
      responseContentDisposition: `attachment; filename="${video.title}"`,
    });
  }
}

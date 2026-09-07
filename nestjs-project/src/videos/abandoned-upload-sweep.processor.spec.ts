import { FindManyOptions, Repository } from 'typeorm';
import { STORAGE_CONTENT_TYPE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { AbandonedUploadSweepProcessor } from './abandoned-upload-sweep.processor';
import { Video } from './entities/video.entity';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    public_id: 'public-id',
    channel_id: 'channel-id',
    title: 'video.mp4',
    status: 'draft',
    failure_reason: null,
    original_key: 'video-id/video.mp4',
    thumbnail_key: null,
    duration_seconds: null,
    upload_id: 'upload-123',
    upload_expires_at: new Date(Date.now() - 1000),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

describe('AbandonedUploadSweepProcessor', () => {
  let videoRepository: {
    find: jest.MockedFunction<Repository<Video>['find']>;
    update: jest.MockedFunction<Repository<Video>['update']>;
  };
  let storageService: jest.Mocked<
    Pick<StorageService, 'resolveBucket' | 'abortMultipartUpload'>
  >;
  let processor: AbandonedUploadSweepProcessor;

  beforeEach(() => {
    videoRepository = {
      find: jest.fn(),
      update: jest.fn(),
    };
    storageService = {
      resolveBucket: jest.fn().mockReturnValue('streamtube-videos'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    processor = new AbandonedUploadSweepProcessor(
      videoRepository as unknown as Repository<Video>,
      storageService as unknown as StorageService,
    );
  });

  it('selects draft videos whose upload window has already expired', async () => {
    videoRepository.find.mockResolvedValue([]);

    await processor.process();

    expect(videoRepository.find).toHaveBeenCalledTimes(1);
    const call = videoRepository.find.mock
      .calls[0]?.[0] as FindManyOptions<Video>;
    const where = call.where as {
      status: string;
      upload_expires_at: { value: Date };
    };
    expect(where.status).toBe('draft');
    expect(where.upload_expires_at.value).toBeInstanceOf(Date);
  });

  it('aborts the multipart upload and marks the video failed for each eligible video', async () => {
    const video = makeVideo();
    videoRepository.find.mockResolvedValue([video]);

    await processor.process();

    expect(storageService.resolveBucket).toHaveBeenCalledWith(
      STORAGE_CONTENT_TYPE.VIDEO,
    );
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'streamtube-videos',
      video.original_key,
      video.upload_id,
    );
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: video.id, status: 'draft' },
      {
        status: 'failed',
        failure_reason: 'Upload expired before completion',
        upload_id: null,
      },
    );
  });

  it('skips aborting the multipart upload when the video has no upload_id', async () => {
    const video = makeVideo({ upload_id: null });
    videoRepository.find.mockResolvedValue([video]);

    await processor.process();

    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.update).toHaveBeenCalled();
  });

  it('does nothing when there are no eligible videos', async () => {
    videoRepository.find.mockResolvedValue([]);

    await processor.process();

    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
  });
});

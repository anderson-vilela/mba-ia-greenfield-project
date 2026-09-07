import type { Queue } from 'bullmq';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  UnsupportedMediaTypeException,
  UploadFileTooLargeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoUploadAlreadyCompletedException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

const mockConfig = {
  maxUploadSizeBytes: 1000,
  acceptedMimeTypes: ['video/mp4'],
  multipartPartSizeBytes: 100,
  uploadAbandonedTtlSeconds: 3600,
  presignedStreamUrlTtlSeconds: 300,
  presignedDownloadUrlTtlSeconds: 900,
};

function makeDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    filename: 'video.mp4',
    content_type: 'video/mp4',
    file_size: 250,
    ...overrides,
  };
}

function makeChannel(): Channel {
  return makeChannelWithId('channel-id');
}

function makeChannelWithId(id: string): Channel {
  const c = new Channel();
  c.id = id;
  c.user_id = 'user-id';
  return c;
}

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
    upload_expires_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

function makeCompleteUploadDto(): CompleteUploadDto {
  const dto = new CompleteUploadDto();
  dto.parts = [{ part_number: 1, etag: 'etag-1' }];
  return dto;
}

describe('VideosService', () => {
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
    update: jest.Mock;
  };
  let channelsService: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let storageService: jest.Mocked<
    Pick<
      StorageService,
      | 'resolveBucket'
      | 'createMultipartUpload'
      | 'presignUploadParts'
      | 'completeMultipartUpload'
      | 'presignGetObject'
    >
  >;
  let videoProcessingQueue: jest.Mocked<Pick<Queue, 'add'>>;
  let service: VideosService;

  beforeEach(() => {
    videoRepository = {
      create: jest.fn((v: Partial<Video>) => v as Video),
      save: jest.fn((v: Partial<Video>) =>
        Promise.resolve({
          ...v,
          created_at: new Date(),
          updated_at: new Date(),
        } as Video),
      ),
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    channelsService = { findByUserId: jest.fn() };
    storageService = {
      resolveBucket: jest.fn().mockReturnValue('streamtube-videos'),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      presignUploadParts: jest
        .fn()
        .mockResolvedValue([
          'https://signed/1',
          'https://signed/2',
          'https://signed/3',
        ]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignGetObject: jest
        .fn()
        .mockResolvedValue('https://signed/stream-url'),
    };
    videoProcessingQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    service = new VideosService(
      videoRepository as unknown as ConstructorParameters<
        typeof VideosService
      >[0],
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
      videoProcessingQueue as unknown as Queue,
      mockConfig as unknown as ConstructorParameters<typeof VideosService>[4],
    );
  });

  describe('initiateUpload', () => {
    it('throws UploadFileTooLargeException when file_size exceeds the configured limit', async () => {
      await expect(
        service.initiateUpload('user-id', makeDto({ file_size: 1001 })),
      ).rejects.toBeInstanceOf(UploadFileTooLargeException);

      expect(channelsService.findByUserId).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws UnsupportedMediaTypeException when content_type is not accepted', async () => {
      await expect(
        service.initiateUpload(
          'user-id',
          makeDto({ content_type: 'application/pdf' }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

      expect(channelsService.findByUserId).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('creates the video in draft under the caller channel and returns one presigned URL per part', async () => {
      channelsService.findByUserId.mockResolvedValue(makeChannel());

      const result = await service.initiateUpload('user-id', makeDto());

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-id');
      expect(storageService.presignUploadParts).toHaveBeenCalledWith(
        'streamtube-videos',
        expect.stringContaining('/video.mp4'),
        'upload-123',
        3,
      );
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-id',
          title: 'video.mp4',
          upload_id: 'upload-123',
        }),
      );
      expect(result.upload_id).toBe('upload-123');
      expect(result.parts).toEqual([
        { part_number: 1, url: 'https://signed/1' },
        { part_number: 2, url: 'https://signed/2' },
        { part_number: 3, url: 'https://signed/3' },
      ]);
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.completeUpload('video-id', 'user-id', makeCompleteUploadDto()),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(channelsService.findByUserId).not.toHaveBeenCalled();
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws VideoAccessDeniedException when the video belongs to another channel', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      channelsService.findByUserId.mockResolvedValue(
        makeChannelWithId('other-channel-id'),
      );

      await expect(
        service.completeUpload('video-id', 'user-id', makeCompleteUploadDto()),
      ).rejects.toBeInstanceOf(VideoAccessDeniedException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws VideoUploadAlreadyCompletedException when the video is not in draft', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: 'processing' }),
      );
      channelsService.findByUserId.mockResolvedValue(makeChannel());

      await expect(
        service.completeUpload('video-id', 'user-id', makeCompleteUploadDto()),
      ).rejects.toBeInstanceOf(VideoUploadAlreadyCompletedException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws VideoUploadAlreadyCompletedException when the guarded update finds no draft row (concurrent completion)', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload('video-id', 'user-id', makeCompleteUploadDto()),
      ).rejects.toBeInstanceOf(VideoUploadAlreadyCompletedException);

      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });

    it('completes the multipart upload, transitions to processing and enqueues the video-processing job', async () => {
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      channelsService.findByUserId.mockResolvedValue(makeChannel());

      const result = await service.completeUpload(
        'video-id',
        'user-id',
        makeCompleteUploadDto(),
      );

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'streamtube-videos',
        'video-id/video.mp4',
        'upload-123',
        [{ partNumber: 1, eTag: 'etag-1' }],
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-id', status: 'draft' },
        { status: 'processing', upload_id: null },
      );
      expect(videoProcessingQueue.add).toHaveBeenCalledWith('process-video', {
        videoId: 'video-id',
      });
      expect(result).toEqual({ id: 'video-id', status: 'processing' });
    });
  });

  describe('getStreamUrl', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.getStreamUrl('video-id')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );

      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it.each(['draft', 'processing', 'failed'])(
      'throws VideoNotReadyException when status is %s',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(
          makeVideo({ status: status as Video['status'] }),
        );

        await expect(service.getStreamUrl('video-id')).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );

        expect(storageService.presignGetObject).not.toHaveBeenCalled();
      },
    );

    it('returns a presigned streaming URL for a ready video', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: 'ready', original_key: 'video-id/video.mp4' }),
      );

      const url = await service.getStreamUrl('aBcDeFgHiJk');

      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        public_id: 'aBcDeFgHiJk',
      });
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'streamtube-videos',
        'video-id/video.mp4',
        { ttlSeconds: 300 },
      );
      expect(url).toBe('https://signed/stream-url');
    });
  });

  describe('getDownloadUrl', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.getDownloadUrl('video-id')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );

      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it.each(['draft', 'processing', 'failed'])(
      'throws VideoNotReadyException when status is %s',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(
          makeVideo({ status: status as Video['status'] }),
        );

        await expect(service.getDownloadUrl('video-id')).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );

        expect(storageService.presignGetObject).not.toHaveBeenCalled();
      },
    );

    it('returns a presigned download URL with an attachment filename, on its own TTL', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({
          status: 'ready',
          title: 'my-video.mp4',
          original_key: 'video-id/video.mp4',
        }),
      );

      const url = await service.getDownloadUrl('aBcDeFgHiJk');

      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        public_id: 'aBcDeFgHiJk',
      });
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'streamtube-videos',
        'video-id/video.mp4',
        {
          ttlSeconds: 900,
          responseContentDisposition: 'attachment; filename="my-video.mp4"',
        },
      );
      expect(url).toBe('https://signed/stream-url');
    });
  });
});

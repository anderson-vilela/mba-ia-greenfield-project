import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoUploadAlreadyCompletedException } from './videos.exceptions';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const mockConfig = {
  maxUploadSizeBytes: 10_737_418_240,
  acceptedMimeTypes: ['video/mp4'],
  multipartPartSizeBytes: 104_857_600,
  uploadAbandonedTtlSeconds: 86_400,
};

function makeStorageService(): jest.Mocked<
  Pick<
    StorageService,
    | 'resolveBucket'
    | 'createMultipartUpload'
    | 'presignUploadParts'
    | 'completeMultipartUpload'
  >
> {
  return {
    resolveBucket: jest.fn().mockReturnValue('streamtube-videos'),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
    presignUploadParts: jest.fn().mockResolvedValue(['https://signed/1']),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };
}

function makeVideoProcessingQueue(): jest.Mocked<Pick<Queue, 'add'>> {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videosService: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videoProcessingQueue: jest.Mocked<Pick<Queue, 'add'>>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    const channelsService = new ChannelsService(dataSource);
    videoProcessingQueue = makeVideoProcessingQueue();
    videosService = new VideosService(
      videoRepository,
      channelsService,
      makeStorageService() as unknown as StorageService,
      videoProcessingQueue as unknown as Queue,
      mockConfig as unknown as ConstructorParameters<typeof VideosService>[4],
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    videoProcessingQueue.add.mockClear();
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `videos_svc_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  function makeDto(): CreateVideoDto {
    return {
      filename: 'video.mp4',
      content_type: 'video/mp4',
      file_size: 1000,
    };
  }

  it('persists the video in draft under the caller channel', async () => {
    const channel = await createChannel();

    const result = await videosService.initiateUpload(
      channel.user_id,
      makeDto(),
    );

    const persisted = await videoRepository.findOneBy({ id: result.id });
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe('draft');
    expect(persisted!.channel_id).toBe(channel.id);
    expect(persisted!.public_id).toBe(result.public_id);
    expect(persisted!.upload_id).toBe('upload-123');
    expect(persisted!.upload_expires_at).not.toBeNull();
  });

  describe('completeUpload', () => {
    function makeCompleteUploadDto(): CompleteUploadDto {
      const dto = new CompleteUploadDto();
      dto.parts = [{ part_number: 1, etag: 'etag-1' }];
      return dto;
    }

    async function createDraftVideo(channel: Channel): Promise<Video> {
      return videoRepository.save(
        videoRepository.create({
          public_id: `pub_${channel.id}`,
          channel_id: channel.id,
          title: 'video.mp4',
          original_key: `${channel.id}/video.mp4`,
          upload_id: 'upload-123',
          upload_expires_at: new Date(Date.now() + 86_400_000),
        }),
      );
    }

    it('transitions the video from draft to processing and clears upload_id', async () => {
      const channel = await createChannel();
      const video = await createDraftVideo(channel);

      const result = await videosService.completeUpload(
        video.id,
        channel.user_id,
        makeCompleteUploadDto(),
      );

      expect(result).toEqual({ id: video.id, status: 'processing' });

      const persisted = await videoRepository.findOneBy({ id: video.id });
      expect(persisted!.status).toBe('processing');
      expect(persisted!.upload_id).toBeNull();
      expect(videoProcessingQueue.add).toHaveBeenCalledTimes(1);
    });

    it('rejects a second completion of the same video as already completed', async () => {
      const channel = await createChannel();
      const video = await createDraftVideo(channel);

      await videosService.completeUpload(
        video.id,
        channel.user_id,
        makeCompleteUploadDto(),
      );

      await expect(
        videosService.completeUpload(
          video.id,
          channel.user_id,
          makeCompleteUploadDto(),
        ),
      ).rejects.toBeInstanceOf(VideoUploadAlreadyCompletedException);

      expect(videoProcessingQueue.add).toHaveBeenCalledTimes(1);
    });
  });
});

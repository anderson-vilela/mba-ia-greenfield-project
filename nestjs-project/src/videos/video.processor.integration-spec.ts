import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { STORAGE_CONTENT_TYPE } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  clearTestStorageObjects,
  createTestS3Client,
  TEST_STORAGE_KEY_PREFIX,
} from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const SAMPLE_VIDEO_DURATION_SECONDS = 3;

async function generateSyntheticVideo(): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${SAMPLE_VIDEO_DURATION_SECONDS}:size=320x240:rate=25`,
      '-pix_fmt',
      'yuv420p',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 },
  );

  return stdout;
}

describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let processor: VideoProcessor;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videosBucket: string;
  let thumbnailsBucket: string;
  let thumbnailKeyToClean: string | undefined;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storageService = module.get(StorageService);
    videosBucket = storageService.resolveBucket(STORAGE_CONTENT_TYPE.VIDEO);
    thumbnailsBucket = storageService.resolveBucket(
      STORAGE_CONTENT_TYPE.THUMBNAIL,
    );

    processor = new VideoProcessor(
      videoRepository,
      storageService,
      new FfmpegService(),
      { presignedDownloadUrlTtlSeconds: 900 } as any,
    );
  }, 30_000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    await clearTestStorageObjects();
    if (thumbnailKeyToClean) {
      const client = createTestS3Client();
      await client.send(
        new DeleteObjectCommand({
          Bucket: thumbnailsBucket,
          Key: thumbnailKeyToClean,
        }),
      );
      thumbnailKeyToClean = undefined;
    }
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_processor_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_processor_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  it('extracts duration and thumbnail from a real video and marks it ready', async () => {
    const channel = await createChannel();
    const key = `${TEST_STORAGE_KEY_PREFIX}${Date.now()}-sample.mp4`;
    const sampleVideo = await generateSyntheticVideo();
    await storageService.putObject(videosBucket, key, sampleVideo, 'video/mp4');

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `pub_${channel.id}`,
        channel_id: channel.id,
        title: 'sample.mp4',
        status: 'processing',
        original_key: key,
      }),
    );
    thumbnailKeyToClean = `${video.id}/thumbnail.jpg`;

    await processor.process({
      data: { videoId: video.id },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as any);

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe('ready');
    expect(persisted!.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(persisted!.duration_seconds).toBeLessThanOrEqual(
      SAMPLE_VIDEO_DURATION_SECONDS + 2,
    );
    expect(persisted!.thumbnail_key).toBe(thumbnailKeyToClean);

    const client = createTestS3Client();
    await expect(
      client.send(
        new HeadObjectCommand({
          Bucket: thumbnailsBucket,
          Key: persisted!.thumbnail_key!,
        }),
      ),
    ).resolves.toBeDefined();
  }, 30_000);
});

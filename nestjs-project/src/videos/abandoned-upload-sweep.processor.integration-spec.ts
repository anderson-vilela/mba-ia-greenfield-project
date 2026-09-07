import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { STORAGE_CONTENT_TYPE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { TEST_STORAGE_KEY_PREFIX } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { AbandonedUploadSweepProcessor } from './abandoned-upload-sweep.processor';
import { Video } from './entities/video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('AbandonedUploadSweepProcessor (integration)', () => {
  let dataSource: DataSource;
  let processor: AbandonedUploadSweepProcessor;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let bucket: string;

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
    bucket = storageService.resolveBucket(STORAGE_CONTENT_TYPE.VIDEO);

    processor = new AbandonedUploadSweepProcessor(
      videoRepository,
      storageService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `sweep_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `sweep_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  it('marks an expired draft video as failed and aborts its multipart upload', async () => {
    const channel = await createChannel();
    const key = `${TEST_STORAGE_KEY_PREFIX}${Date.now()}-expired.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `pub_${channel.id}`,
        channel_id: channel.id,
        title: 'expired.mp4',
        original_key: key,
        upload_id: uploadId,
        upload_expires_at: new Date(Date.now() - 1000),
      }),
    );

    await processor.process();

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe('failed');
    expect(persisted!.failure_reason).toBeTruthy();
    expect(persisted!.upload_id).toBeNull();

    await expect(
      storageService.completeMultipartUpload(bucket, key, uploadId, [
        { partNumber: 1, eTag: 'does-not-matter' },
      ]),
    ).rejects.toThrow();
  });

  it('does not touch a draft video still within its upload TTL', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `pub_${channel.id}`,
        channel_id: channel.id,
        title: 'fresh.mp4',
        original_key: `${channel.id}/fresh.mp4`,
        upload_id: 'upload-not-expired',
        upload_expires_at: new Date(Date.now() + 86_400_000),
      }),
    );

    await processor.process();

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe('draft');
  });

  it('running the sweep twice on the same video does not error nor re-attempt the abort', async () => {
    const channel = await createChannel();
    const key = `${TEST_STORAGE_KEY_PREFIX}${Date.now()}-double.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `pub_${channel.id}`,
        channel_id: channel.id,
        title: 'double.mp4',
        original_key: key,
        upload_id: uploadId,
        upload_expires_at: new Date(Date.now() - 1000),
      }),
    );

    await processor.process();
    await expect(processor.process()).resolves.not.toThrow();

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe('failed');
  });
});

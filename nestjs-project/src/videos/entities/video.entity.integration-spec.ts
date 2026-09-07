import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let channelCounter = 0;
  async function createChannel(): Promise<Channel> {
    channelCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${channelCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_chan_${channelCounter}`,
        user_id: user.id,
      }),
    );
  }

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'abc12345678',
        channel_id: channel.id,
        title: 'video.mp4',
        original_key: `${channel.id}/orig.mp4`,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'abc12345678',
          channel_id: channel.id,
          title: 'video2.mp4',
          original_key: `${channel.id}/orig2.mp4`,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft when not informed', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: 'def12345678',
        channel_id: channel.id,
        title: 'video.mp4',
        original_key: `${channel.id}/orig.mp4`,
      }),
    );

    expect(video.status).toBe('draft');
  });

  it('should allow null on optional processing/upload columns', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: 'ghi12345678',
        channel_id: channel.id,
        title: 'video.mp4',
        original_key: `${channel.id}/orig.mp4`,
      }),
    );

    expect(video.failure_reason).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.upload_expires_at).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'jkl12345678',
        channel_id: channel.id,
        title: 'video.mp4',
        original_key: `${channel.id}/orig.mp4`,
      }),
    );

    const found = await videoRepository.findOne({
      where: { public_id: 'jkl12345678' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});

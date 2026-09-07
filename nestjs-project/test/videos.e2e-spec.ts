import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { ChannelsService } from '../src/channels/channels.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { generateVideoPublicId } from '../src/videos/public-id.util';
import { Video, type VideoStatus } from '../src/videos/entities/video.entity';
import { User } from '../src/users/entities/user.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { clearVideoProcessingQueue } from '../src/test/queue';

/** Payloads the videos endpoints return; supertest types `body` as `any`. */
interface VideoResponseBody {
  id?: string;
  public_id?: string;
  status?: string;
  error?: string;
  upload_id?: string;
  parts?: { part_number: number; url: string }[];
  access_token?: string;
}

const body = (res: request.Response): VideoResponseBody =>
  res.body as VideoResponseBody;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoProcessingQueue: Queue;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoProcessingQueue = moduleFixture.get<Queue>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    videoRepository = moduleFixture.get<Repository<Video>>(
      getRepositoryToken(Video),
    );
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await clearVideoProcessingQueue();
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const { mailService } = authService as unknown as {
      mailService: MailService;
    };
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return { access_token: body(res).access_token as unknown as string };
  }

  async function initiateDraftUpload(
    accessToken: string,
  ): Promise<{ id: string; part: { part_number: number; url: string } }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'video.mp4',
        content_type: 'video/mp4',
        file_size: 1000,
      })
      .expect(201);

    const { id, parts } = body(res);
    return { id: id!, part: parts![0] };
  }

  async function completePart(url: string): Promise<string> {
    const putResponse = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('fake-video-bytes'),
    });
    const eTag = putResponse.headers.get('etag');
    return (eTag as string).replace(/"/g, '');
  }

  async function createVideoWithStatus(
    status: VideoStatus,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const email = `stream-download-${randomUUID()}@example.com`;
    await registerConfirmAndLogin(email);
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await app.get(ChannelsService).findByUserId(user.id);

    return videoRepository.save(
      videoRepository.create({
        id: randomUUID(),
        public_id: generateVideoPublicId(),
        channel_id: channel!.id,
        title: 'video.mp4',
        status,
        original_key: `${randomUUID()}/video.mp4`,
        ...overrides,
      }),
    );
  }

  describe('POST /videos', () => {
    it('creates a draft video and returns one presigned URL per multipart part', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'initiate-upload-1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'holidays.mp4',
          content_type: 'video/mp4',
          file_size: 150 * 1024 * 1024,
        })
        .expect(201);

      const { id, public_id, upload_id, parts } = body(res);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(upload_id).toBeTruthy();
      expect(parts).toHaveLength(2);
      expect(parts![0]).toEqual({
        part_number: 1,
        url: expect.stringContaining('partNumber=1') as string,
      });

      const persisted = await videoRepository.findOneByOrFail({ id });
      expect(persisted.status).toBe('draft');
      expect(persisted.title).toBe('holidays.mp4');
    }, 30000);

    it('rejects a file above the configured maximum size', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'initiate-upload-too-large@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'huge.mp4',
          content_type: 'video/mp4',
          file_size: 10 * 1024 * 1024 * 1024 + 1,
        })
        .expect(413);

      expect(body(res).error).toBe('UPLOAD_FILE_TOO_LARGE');
    });

    it('rejects an unsupported content type', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'initiate-upload-bad-type@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          filename: 'notes.pdf',
          content_type: 'application/pdf',
          file_size: 1000,
        })
        .expect(415);

      expect(body(res).error).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          filename: 'video.mp4',
          content_type: 'video/mp4',
          file_size: 1000,
        })
        .expect(401);
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    it('completes the multipart upload and enqueues exactly one video-processing job', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete-upload-1@example.com',
      );
      const { id, part } = await initiateDraftUpload(access_token);
      const etag = await completePart(part.url);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: part.part_number, etag }] })
        .expect(202);

      expect(body(res).id).toBe(id);
      expect(body(res).status).toBe('processing');

      const counts = await videoProcessingQueue.getJobCounts();
      expect(
        counts.waiting + counts.active + counts.completed,
      ).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('denies completion of a video owned by another channel', async () => {
      const owner = await registerConfirmAndLogin(
        'complete-upload-owner@example.com',
      );
      const stranger = await registerConfirmAndLogin(
        'complete-upload-stranger@example.com',
      );
      const { id } = await initiateDraftUpload(owner.access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete-upload`)
        .set('Authorization', `Bearer ${stranger.access_token}`)
        .send({ parts: [{ part_number: 1, etag: 'does-not-matter' }] })
        .expect(403);

      expect(body(res).error).toBe('VIDEO_ACCESS_DENIED');
    });

    it('rejects completing the same upload twice', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete-upload-dup@example.com',
      );
      const { id, part } = await initiateDraftUpload(access_token);
      const etag = await completePart(part.url);

      await request(app.getHttpServer())
        .post(`/videos/${id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: part.part_number, etag }] })
        .expect(202);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: part.part_number, etag }] })
        .expect(409);

      expect(body(res).error).toBe('VIDEO_UPLOAD_ALREADY_COMPLETED');
    }, 30000);

    it('returns 404 for a nonexistent video id', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete-upload-notfound@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${randomUUID()}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ part_number: 1, etag: 'does-not-matter' }] })
        .expect(404);

      expect(body(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('redirects to a presigned URL when the video is ready', async () => {
      const video = await createVideoWithStatus('ready');

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .redirects(0)
        .expect(302);

      expect(res.headers.location).toContain('streamtube-videos');
    });

    it.each(['draft', 'processing', 'failed'] as const)(
      'rejects a video that is not ready (status: %s)',
      async (status) => {
        const video = await createVideoWithStatus(status);

        const res = await request(app.getHttpServer())
          .get(`/videos/${video.public_id}/stream`)
          .redirects(0)
          .expect(409);

        expect(body(res).error).toBe('VIDEO_NOT_READY');
      },
    );

    it('returns 404 for a nonexistent public id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${generateVideoPublicId()}/stream`)
        .redirects(0)
        .expect(404);

      expect(body(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('is accessible without an access token', async () => {
      const video = await createVideoWithStatus('ready');

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .redirects(0)
        .expect(302);
    });

    it('does not resolve the internal uuid, only the public id', async () => {
      const video = await createVideoWithStatus('ready');

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .redirects(0)
        .expect(404);

      expect(body(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('redirects to a presigned URL with an attachment content-disposition, on its own TTL', async () => {
      const video = await createVideoWithStatus('ready', {
        title: 'my-video.mp4',
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .redirects(0)
        .expect(302);

      const location = res.headers.location;
      expect(location).toContain('streamtube-videos');
      expect(decodeURIComponent(location)).toContain(
        'response-content-disposition=attachment; filename="my-video.mp4"',
      );
      expect(location).toContain('X-Amz-Expires=900');
    });

    it.each(['draft', 'processing', 'failed'] as const)(
      'rejects a video that is not ready (status: %s)',
      async (status) => {
        const video = await createVideoWithStatus(status);

        const res = await request(app.getHttpServer())
          .get(`/videos/${video.public_id}/download`)
          .redirects(0)
          .expect(409);

        expect(body(res).error).toBe('VIDEO_NOT_READY');
      },
    );

    it('returns 404 for a nonexistent public id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${generateVideoPublicId()}/download`)
        .redirects(0)
        .expect(404);

      expect(body(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('is accessible without an access token', async () => {
      const video = await createVideoWithStatus('ready');

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .redirects(0)
        .expect(302);
    });
  });
});

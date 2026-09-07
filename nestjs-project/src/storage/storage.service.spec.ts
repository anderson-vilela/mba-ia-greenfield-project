import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { STORAGE_CONTENT_TYPE } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const STORAGE_ENV_KEYS = [
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_VIDEOS_BUCKET',
  'STORAGE_THUMBNAILS_BUCKET',
  'STORAGE_PRESIGNED_UPLOAD_URL_TTL_SECONDS',
] as const;

describe('StorageService (unit)', () => {
  let service: StorageService;

  beforeAll(async () => {
    for (const key of STORAGE_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, {
      STORAGE_ENDPOINT: 'http://storage:9000',
      STORAGE_REGION: 'us-east-1',
      STORAGE_ACCESS_KEY_ID: 'test-access-key',
      STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      STORAGE_VIDEOS_BUCKET: 'streamtube-videos',
      STORAGE_THUMBNAILS_BUCKET: 'streamtube-thumbnails',
      STORAGE_PRESIGNED_UPLOAD_URL_TTL_SECONDS: '3600',
    });

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
  });

  describe('resolveBucket', () => {
    it('resolves the videos bucket for video content', () => {
      expect(service.resolveBucket(STORAGE_CONTENT_TYPE.VIDEO)).toBe(
        'streamtube-videos',
      );
    });

    it('resolves the thumbnails bucket for thumbnail content', () => {
      expect(service.resolveBucket(STORAGE_CONTENT_TYPE.THUMBNAIL)).toBe(
        'streamtube-thumbnails',
      );
    });
  });

  describe('presignUploadParts', () => {
    it('returns one presigned url per part, all pointing at the storage endpoint with the configured ttl', async () => {
      const urls = await service.presignUploadParts(
        'streamtube-videos',
        'video-1/source.mp4',
        'upload-id-123',
        3,
      );

      expect(urls).toHaveLength(3);
      urls.forEach((url, index) => {
        expect(
          url.startsWith(
            'http://storage:9000/streamtube-videos/video-1/source.mp4',
          ),
        ).toBe(true);
        expect(url).toContain(`partNumber=${index + 1}`);
        expect(url).toContain('uploadId=upload-id-123');
        expect(url).toContain('X-Amz-Expires=3600');
      });
    });
  });

  describe('presignGetObject', () => {
    it('signs a GET url with the given ttl and no response overrides', async () => {
      const url = await service.presignGetObject(
        'streamtube-videos',
        'video-1/source.mp4',
        { ttlSeconds: 300 },
      );

      expect(
        url.startsWith(
          'http://storage:9000/streamtube-videos/video-1/source.mp4',
        ),
      ).toBe(true);
      expect(url).toContain('X-Amz-Expires=300');
      expect(url).not.toContain('response-content-disposition');
    });

    it('signs a GET url carrying response-content-disposition and response-content-type overrides', async () => {
      const url = await service.presignGetObject(
        'streamtube-videos',
        'video-1/source.mp4',
        {
          ttlSeconds: 900,
          responseContentDisposition: 'attachment; filename="my-video.mp4"',
          responseContentType: 'video/mp4',
        },
      );

      expect(url).toContain('X-Amz-Expires=900');
      expect(url).toContain('response-content-disposition=attachment');
      expect(url).toContain('response-content-type=video%2Fmp4');
    });
  });
});

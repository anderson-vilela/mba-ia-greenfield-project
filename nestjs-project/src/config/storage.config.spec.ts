import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const STORAGE_ENV_KEYS = [
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_VIDEOS_BUCKET',
  'STORAGE_THUMBNAILS_BUCKET',
  'STORAGE_PRESIGNED_UPLOAD_URL_TTL_SECONDS',
  'STORAGE_PRESIGNED_STREAM_URL_TTL_SECONDS',
  'STORAGE_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS',
  'STORAGE_UPLOAD_ABANDONED_TTL_SECONDS',
  'UPLOAD_MAX_FILE_SIZE_BYTES',
  'UPLOAD_ACCEPTED_MIME_TYPES',
  'STORAGE_MULTIPART_PART_SIZE_BYTES',
] as const;

const loadConfig = async (
  env: Partial<Record<(typeof STORAGE_ENV_KEYS)[number], string>> = {},
): Promise<ConfigType<typeof storageConfig>> => {
  for (const key of STORAGE_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  await module.close();
  return config;
};

describe('storageConfig', () => {
  afterEach(() => {
    for (const key of STORAGE_ENV_KEYS) delete process.env[key];
  });

  it('should apply defaults when only credentials are set', async () => {
    const config = await loadConfig({
      STORAGE_ACCESS_KEY_ID: 'key',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
    });

    expect(config.endpoint).toBe('http://storage:9000');
    expect(config.region).toBe('us-east-1');
    expect(config.videosBucket).toBe('streamtube-videos');
    expect(config.thumbnailsBucket).toBe('streamtube-thumbnails');
    expect(config.presignedUploadUrlTtlSeconds).toBe(3600);
    expect(config.presignedStreamUrlTtlSeconds).toBe(300);
    expect(config.presignedDownloadUrlTtlSeconds).toBe(900);
    expect(config.uploadAbandonedTtlSeconds).toBe(86400);
    expect(config.maxUploadSizeBytes).toBe(10737418240);
    expect(config.acceptedMimeTypes).toEqual([
      'video/mp4',
      'video/webm',
      'video/quicktime',
    ]);
    expect(config.multipartPartSizeBytes).toBe(104857600);
  });

  it('should read every value from the environment when set', async () => {
    const config = await loadConfig({
      STORAGE_ENDPOINT: 'http://custom-storage:9000',
      STORAGE_REGION: 'sa-east-1',
      STORAGE_ACCESS_KEY_ID: 'custom-key',
      STORAGE_SECRET_ACCESS_KEY: 'custom-secret',
      STORAGE_VIDEOS_BUCKET: 'custom-videos',
      STORAGE_THUMBNAILS_BUCKET: 'custom-thumbnails',
      STORAGE_PRESIGNED_UPLOAD_URL_TTL_SECONDS: '1200',
      STORAGE_PRESIGNED_STREAM_URL_TTL_SECONDS: '60',
      STORAGE_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS: '120',
      STORAGE_UPLOAD_ABANDONED_TTL_SECONDS: '3600',
      UPLOAD_MAX_FILE_SIZE_BYTES: '1000',
      UPLOAD_ACCEPTED_MIME_TYPES: 'video/mp4',
      STORAGE_MULTIPART_PART_SIZE_BYTES: '5000',
    });

    expect(config.endpoint).toBe('http://custom-storage:9000');
    expect(config.region).toBe('sa-east-1');
    expect(config.accessKeyId).toBe('custom-key');
    expect(config.secretAccessKey).toBe('custom-secret');
    expect(config.videosBucket).toBe('custom-videos');
    expect(config.thumbnailsBucket).toBe('custom-thumbnails');
    expect(config.presignedUploadUrlTtlSeconds).toBe(1200);
    expect(config.presignedStreamUrlTtlSeconds).toBe(60);
    expect(config.presignedDownloadUrlTtlSeconds).toBe(120);
    expect(config.uploadAbandonedTtlSeconds).toBe(3600);
    expect(config.maxUploadSizeBytes).toBe(1000);
    expect(config.acceptedMimeTypes).toEqual(['video/mp4']);
    expect(config.multipartPartSizeBytes).toBe(5000);
  });
});

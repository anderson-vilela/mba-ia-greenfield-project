import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  clearTestStorageObjects,
  createTestS3Client,
  TEST_STORAGE_KEY_PREFIX,
} from '../test/storage';
import { STORAGE_CONTENT_TYPE } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let bucket: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
    bucket = service.resolveBucket(STORAGE_CONTENT_TYPE.VIDEO);
  });

  afterEach(async () => {
    await clearTestStorageObjects();
  });

  const testKey = (name: string) =>
    `${TEST_STORAGE_KEY_PREFIX}${Date.now()}-${name}`;

  it('creates a multipart upload and returns a valid UploadId', async () => {
    const key = testKey('create.mp4');

    const uploadId = await service.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );

    expect(typeof uploadId).toBe('string');
    expect(uploadId.length).toBeGreaterThan(0);

    await service.abortMultipartUpload(bucket, key, uploadId);
  });

  it('presigns upload part urls that accept a real PUT and completes the upload', async () => {
    const key = testKey('complete.mp4');
    const uploadId = await service.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );
    const [uploadUrl] = await service.presignUploadParts(
      bucket,
      key,
      uploadId,
      1,
    );

    const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: partBody,
    });
    expect(putResponse.ok).toBe(true);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(bucket, key, uploadId, [
      { partNumber: 1, eTag: (eTag as string).replace(/"/g, '') },
    ]);

    const client = createTestS3Client();
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    expect(head.ContentLength).toBe(partBody.length);
  }, 30000);

  it('aborts a multipart upload so it can no longer be completed', async () => {
    const key = testKey('aborted.mp4');
    const uploadId = await service.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );

    await service.abortMultipartUpload(bucket, key, uploadId);

    await expect(
      service.completeMultipartUpload(bucket, key, uploadId, [
        { partNumber: 1, eTag: 'does-not-matter' },
      ]),
    ).rejects.toThrow();
  });

  it('generates a presigned GET url with the requested ttl against the real storage endpoint', async () => {
    const key = testKey('get.mp4');
    const url = await service.presignGetObject(bucket, key, {
      ttlSeconds: 60,
    });

    expect(url).toContain('X-Amz-Expires=60');

    const response = await fetch(url);
    expect(response.status).toBe(404);
  });
});

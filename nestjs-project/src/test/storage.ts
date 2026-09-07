import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export const TEST_STORAGE_KEY_PREFIX =
  process.env.STORAGE_TEST_KEY_PREFIX ?? 'test/';

export function createTestS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://storage:9000',
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
    },
  });
}

async function clearBucketTestObjects(
  client: S3Client,
  bucket: string,
): Promise<void> {
  const listed = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: TEST_STORAGE_KEY_PREFIX,
    }),
  );
  const keys = (listed.Contents ?? [])
    .map((object) => object.Key)
    .filter((key): key is string => key !== undefined);

  if (keys.length === 0) {
    return;
  }

  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  );
}

export async function clearTestStorageObjects(): Promise<void> {
  const client = createTestS3Client();
  const videosBucket = process.env.STORAGE_VIDEOS_BUCKET ?? 'streamtube-videos';
  const thumbnailsBucket =
    process.env.STORAGE_THUMBNAILS_BUCKET ?? 'streamtube-thumbnails';

  await Promise.all([
    clearBucketTestObjects(client, videosBucket),
    clearBucketTestObjects(client, thumbnailsBucket),
  ]);
}

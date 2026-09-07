import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://storage:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  videosBucket: process.env.STORAGE_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket:
    process.env.STORAGE_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
  presignedUploadUrlTtlSeconds: parseInt(
    process.env.STORAGE_PRESIGNED_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  presignedStreamUrlTtlSeconds: parseInt(
    process.env.STORAGE_PRESIGNED_STREAM_URL_TTL_SECONDS || '300',
    10,
  ),
  presignedDownloadUrlTtlSeconds: parseInt(
    process.env.STORAGE_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS || '900',
    10,
  ),
  uploadAbandonedTtlSeconds: parseInt(
    process.env.STORAGE_UPLOAD_ABANDONED_TTL_SECONDS || '86400',
    10,
  ),
  maxUploadSizeBytes: parseInt(
    process.env.UPLOAD_MAX_FILE_SIZE_BYTES || '10737418240',
    10,
  ),
  acceptedMimeTypes: (
    process.env.UPLOAD_ACCEPTED_MIME_TYPES ||
    'video/mp4,video/webm,video/quicktime'
  ).split(','),
  multipartPartSizeBytes: parseInt(
    process.env.STORAGE_MULTIPART_PART_SIZE_BYTES || '104857600',
    10,
  ),
}));

export const STORAGE_CONTENT_TYPE = {
  VIDEO: 'video',
  THUMBNAIL: 'thumbnail',
} as const;

export type StorageContentType =
  (typeof STORAGE_CONTENT_TYPE)[keyof typeof STORAGE_CONTENT_TYPE];

import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  STORAGE_CONTENT_TYPE,
  type StorageContentType,
} from './storage.constants';

export interface CompletedUploadPart {
  partNumber: number;
  eTag: string;
}

export interface PresignGetObjectOptions {
  ttlSeconds: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}

@Injectable()
export class StorageService {
  private readonly s3: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.s3 = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId ?? '',
        secretAccessKey: this.config.secretAccessKey ?? '',
      },
    });
  }

  resolveBucket(contentType: StorageContentType): string {
    return contentType === STORAGE_CONTENT_TYPE.VIDEO
      ? this.config.videosBucket
      : this.config.thumbnailsBucket;
  }

  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error(
        `Storage did not return an UploadId for ${bucket}/${key}`,
      );
    }

    return result.UploadId;
  }

  async presignUploadParts(
    bucket: string,
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<string[]> {
    const urls: string[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.s3,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: this.config.presignedUploadUrlTtlSeconds },
      );
      urls.push(url);
    }

    return urls;
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[],
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGetObject(
    bucket: string,
    key: string,
    options: PresignGetObjectOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
        ResponseContentType: options.responseContentType,
      }),
      { expiresIn: options.ttlSeconds },
    );
  }
}

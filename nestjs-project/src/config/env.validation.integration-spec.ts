import * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as Joi.ValidationResult<Record<string, string | number>>;

const validateRaw = (env: Record<string, string>) =>
  envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  }) as Joi.ValidationResult<Record<string, string | number>>;

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    // ValidationResult is a discriminated union: only the error-free branch
    // types `value`, so narrow before reading the validated env.
    if (result.error) throw result.error;
    expect(result.value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — QUEUE_HOST / QUEUE_PORT', () => {
  it('should apply defaults when not set', () => {
    const result = validate({});
    if (result.error) throw result.error;
    expect(result.value.QUEUE_HOST).toBe('valkey');
    expect(result.value.QUEUE_PORT).toBe(6379);
  });

  it('should reject a non-numeric QUEUE_PORT', () => {
    const { error } = validate({ QUEUE_PORT: 'not-a-number' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_PORT');
  });
});

describe('envValidationSchema — STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY', () => {
  it('should reject when STORAGE_ACCESS_KEY_ID is missing', () => {
    const { error } = validateRaw({
      DB_USERNAME: 'user',
      DB_PASSWORD: 'pass',
      DB_NAME: 'db',
      JWT_SECRET: 'secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY_ID');
  });

  it('should reject when STORAGE_SECRET_ACCESS_KEY is missing', () => {
    const { error } = validateRaw({
      DB_USERNAME: 'user',
      DB_PASSWORD: 'pass',
      DB_NAME: 'db',
      JWT_SECRET: 'secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      STORAGE_ACCESS_KEY_ID: 'key',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_ACCESS_KEY');
  });

  it('should accept when both are set', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });
});

describe('envValidationSchema — storage & upload defaults', () => {
  it('should apply the documented defaults', () => {
    const result = validate({});
    if (result.error) throw result.error;
    expect(result.value.STORAGE_ENDPOINT).toBe('http://storage:9000');
    expect(result.value.STORAGE_REGION).toBe('us-east-1');
    expect(result.value.STORAGE_VIDEOS_BUCKET).toBe('streamtube-videos');
    expect(result.value.STORAGE_THUMBNAILS_BUCKET).toBe(
      'streamtube-thumbnails',
    );
    expect(result.value.STORAGE_PRESIGNED_UPLOAD_URL_TTL_SECONDS).toBe(3600);
    expect(result.value.STORAGE_PRESIGNED_STREAM_URL_TTL_SECONDS).toBe(300);
    expect(result.value.STORAGE_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS).toBe(900);
    expect(result.value.STORAGE_UPLOAD_ABANDONED_TTL_SECONDS).toBe(86400);
    expect(result.value.UPLOAD_MAX_FILE_SIZE_BYTES).toBe(10737418240);
    expect(result.value.UPLOAD_ACCEPTED_MIME_TYPES).toBe(
      'video/mp4,video/webm,video/quicktime',
    );
    expect(result.value.STORAGE_MULTIPART_PART_SIZE_BYTES).toBe(104857600);
  });

  it('should reject a non-numeric UPLOAD_MAX_FILE_SIZE_BYTES', () => {
    const { error } = validate({ UPLOAD_MAX_FILE_SIZE_BYTES: 'huge' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_MAX_FILE_SIZE_BYTES');
  });

  it('should reject an invalid STORAGE_ENDPOINT URI', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });
});

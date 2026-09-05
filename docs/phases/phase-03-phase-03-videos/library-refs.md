---
libs:
  "bullmq":
    version: "^6.3.4"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-05T19:01:27-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-05T19:01:27-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1127.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-05T19:01:27-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1127.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-05T19:01:27-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-05T18:59:28-03:00"
---

### bullmq (TD-01)

Fila e worker rodando sobre Redis/Valkey.

- `Queue` cria/enfileira jobs; `Worker` (com `connection` apontando pro serviço `valkey` do Compose — nunca `localhost`) consome.
- Retries com backoff exponencial são configurados por job (`attempts`, `backoff: { type: 'exponential', delay }`) ou como `defaultJobOptions` na `Queue` — usar `defaultJobOptions` para os 3 attempts / backoff exponencial decididos na TD-11.

```typescript
import { Queue, Worker } from 'bullmq';

const myQueue = new Queue('video-processing', {
  connection: { host: 'valkey', port: 6379 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

const worker = new Worker(
  'video-processing',
  async (job) => { /* ffprobe + thumbnail, TD-07 */ },
  { connection: { host: 'valkey', port: 6379 } },
);
```

### @nestjs/bullmq (TD-01)

Integração first-party do BullMQ com Nest — usar no módulo da API para registrar a fila, e no worker (contexto Nest standalone, TD-06) para o processor.

```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRoot({ connection: { host: 'valkey', port: 6379 } }),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
})
export class QueueModule {}
```

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) {
    // ffprobe + thumbnail (TD-07), depois atualiza status (TD-11)
  }
}
```

Nota: não existe pacote Context7 dedicado a `@nestjs/bullmq`; a doc oficial do Nest para filas está publicada sob `/nestjs/bull` (cobre os decorators `@Processor`/`@InjectQueue`/`WorkerHost` do pacote `@nestjs/bullmq`).

### @aws-sdk/client-s3 (TD-02, TD-04, TD-05)

Cliente S3 puro para o handshake multipart (`CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`) contra o MinIO pinado (TD-04), usando os buckets separados por tipo de conteúdo (TD-05). Endpoint do client aponta pro serviço `storage` do Compose, nunca `localhost`.

```typescript
import { S3Client, CreateMultipartUploadCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: 'http://storage:9000',
  forcePathStyle: true,
  region: 'us-east-1',
});

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));
// ... UploadPartCommand por parte, coleta de ETag ...
await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } }));
```

### @aws-sdk/s3-request-presigner (TD-02, TD-09, TD-10)

`getSignedUrl` assina cada `UploadPartCommand` (upload, TD-02) e `GetObjectCommand` (streaming/download, TD-09/TD-10) com TTL curto configurável via env var (Joi, TD-12).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 });
```

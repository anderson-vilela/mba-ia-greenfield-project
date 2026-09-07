import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to bootstrap the video worker', error);
  process.exit(1);
});

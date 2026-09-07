import { Test } from '@nestjs/testing';
import { AbandonedUploadSweepProcessor } from '../videos/abandoned-upload-sweep.processor';
import { VideoProcessor } from '../videos/video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module).toBeDefined();

    await module.close();
  }, 15000);

  it('registers every queue consumer so BullMQ picks them up', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(AbandonedUploadSweepProcessor)).toBeInstanceOf(
      AbandonedUploadSweepProcessor,
    );

    await module.close();
  }, 15000);
});

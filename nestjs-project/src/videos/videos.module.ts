import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { AbandonedUploadSweepScheduler } from './abandoned-upload-sweep.scheduler';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, AbandonedUploadSweepScheduler],
  exports: [VideosService],
})
export class VideosModule {}

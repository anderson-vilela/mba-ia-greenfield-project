import type { Job } from 'bullmq';
import { STORAGE_CONTENT_TYPE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    public_id: 'public-id',
    channel_id: 'channel-id',
    title: 'video.mp4',
    status: 'processing',
    failure_reason: null,
    original_key: 'video-id/video.mp4',
    thumbnail_key: null,
    duration_seconds: null,
    upload_id: null,
    upload_expires_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

function makeJob(overrides: Partial<Job<{ videoId: string }>> = {}) {
  return {
    data: { videoId: 'video-id' },
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...overrides,
  } as unknown as Job<{ videoId: string }>;
}

describe('VideoProcessor', () => {
  let videoRepository: { findOneBy: jest.Mock; update: jest.Mock };
  let storageService: jest.Mocked<
    Pick<StorageService, 'resolveBucket' | 'presignGetObject' | 'putObject'>
  >;
  let ffmpegService: jest.Mocked<
    Pick<FfmpegService, 'probe' | 'extractThumbnail'>
  >;
  let processor: VideoProcessor;

  beforeEach(() => {
    videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
    storageService = {
      resolveBucket: jest.fn((contentType) =>
        contentType === STORAGE_CONTENT_TYPE.VIDEO
          ? 'streamtube-videos'
          : 'streamtube-thumbnails',
      ),
      presignGetObject: jest
        .fn()
        .mockResolvedValue('https://storage/presigned'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpegService = {
      probe: jest.fn(),
      extractThumbnail: jest.fn(),
    };
    processor = new VideoProcessor(
      videoRepository as any,
      storageService as unknown as StorageService,
      ffmpegService as unknown as FfmpegService,
      { presignedDownloadUrlTtlSeconds: 900 } as any,
    );
  });

  it('parses ffprobe duration, extracts a thumbnail at 10% of the duration, and marks the video ready', async () => {
    const video = makeVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    ffmpegService.probe.mockResolvedValue(
      JSON.stringify({ format: { duration: '120.5' } }),
    );
    ffmpegService.extractThumbnail.mockResolvedValue(Buffer.from('jpeg-bytes'));

    await processor.process(makeJob());

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'streamtube-videos',
      video.original_key,
      { ttlSeconds: 900 },
    );
    expect(ffmpegService.extractThumbnail).toHaveBeenCalledWith(
      'https://storage/presigned',
      12.05,
    );
    expect(storageService.putObject).toHaveBeenCalledWith(
      'streamtube-thumbnails',
      `${video.id}/thumbnail.jpg`,
      Buffer.from('jpeg-bytes'),
      'image/jpeg',
    );
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: video.id, status: 'processing' },
      {
        status: 'ready',
        duration_seconds: 121,
        thumbnail_key: `${video.id}/thumbnail.jpg`,
      },
    );
  });

  it('does nothing when the video does not exist', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await processor.process(makeJob());

    expect(ffmpegService.probe).not.toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('does nothing when the video is not in processing status (redelivered job for an already-finalized video)', async () => {
    const video = makeVideo({ status: 'ready' });
    videoRepository.findOneBy.mockResolvedValue(video);

    await processor.process(makeJob());

    expect(ffmpegService.probe).not.toHaveBeenCalled();
    expect(storageService.putObject).not.toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('throws when ffprobe does not return a parseable duration', async () => {
    const video = makeVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    ffmpegService.probe.mockResolvedValue(JSON.stringify({ format: {} }));

    await expect(processor.process(makeJob())).rejects.toThrow(
      'ffprobe did not return a valid duration',
    );

    expect(ffmpegService.extractThumbnail).not.toHaveBeenCalled();
  });

  it('marks the video failed when the processing error happens on the last allowed attempt', async () => {
    const video = makeVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    ffmpegService.probe.mockRejectedValue(new Error('ffprobe crashed'));

    await expect(
      processor.process(makeJob({ attemptsMade: 2 })),
    ).rejects.toThrow('ffprobe crashed');

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: video.id, status: 'processing' },
      { status: 'failed', failure_reason: 'ffprobe crashed' },
    );
  });

  it('does not mark the video failed yet when attempts remain', async () => {
    const video = makeVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    ffmpegService.probe.mockRejectedValue(new Error('transient error'));

    await expect(
      processor.process(makeJob({ attemptsMade: 0 })),
    ).rejects.toThrow('transient error');

    expect(videoRepository.update).not.toHaveBeenCalled();
  });
});

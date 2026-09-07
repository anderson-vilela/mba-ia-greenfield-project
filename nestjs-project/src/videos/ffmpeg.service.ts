import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);
const THUMBNAIL_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

@Injectable()
export class FfmpegService {
  async probe(url: string): Promise<string> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      url,
    ]);

    return stdout;
  }

  async extractThumbnail(url: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        atSeconds.toString(),
        '-i',
        url,
        '-vframes',
        '1',
        '-vf',
        'scale=1280:720',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: THUMBNAIL_MAX_BUFFER_BYTES },
    );

    return stdout;
  }
}

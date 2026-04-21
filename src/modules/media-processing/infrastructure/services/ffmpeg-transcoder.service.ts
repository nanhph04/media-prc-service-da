import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';

export interface Hls720pTranscodeInput {
  inputPath: string;
  masterPlaylistPath: string;
  variantPlaylistPath: string;
  segmentPattern: string;
}

export interface Hls720pTranscodeResult {
  durationSeconds?: number;
}

@Injectable()
export class FfmpegTranscoderService {
  constructor(private readonly configService: ConfigService) {
    const ffmpegPath = this.configService.get<string>('FFMPEG_PATH', '');

    if (ffmpegPath.length > 0) {
      ffmpeg.setFfmpegPath(ffmpegPath);
    }
  }

  async convertMp4ToHls720p(
    input: Hls720pTranscodeInput,
  ): Promise<Hls720pTranscodeResult> {
    await mkdir(dirname(input.segmentPattern), { recursive: true });

    return new Promise<Hls720pTranscodeResult>((resolve, reject) => {
      let durationSeconds: number | undefined;

      ffmpeg(input.inputPath)
        .outputOptions([
          '-preset veryfast',
          '-g 48',
          '-sc_threshold 0',
          '-map 0:v:0',
          '-map 0:a:0?',
          '-c:v:0 h264',
          '-c:a:0 aac',
          '-b:v:0 2800k',
          '-maxrate:v:0 2996k',
          '-bufsize:v:0 4200k',
          '-b:a:0 128k',
          '-s:v:0 1280x720',
          '-f hls',
          '-hls_time 6',
          '-hls_playlist_type vod',
          '-hls_segment_filename',
          input.segmentPattern,
          '-master_pl_name',
          basename(input.masterPlaylistPath),
          '-var_stream_map',
          'v:0,a:0,name:720p',
        ])
        .output(input.variantPlaylistPath)
        .on('codecData', (data: { duration?: string }) => {
          durationSeconds = this.parseDurationSeconds(data.duration);
        })
        .on('end', () => resolve({ durationSeconds }))
        .on('error', (error: Error) => reject(error))
        .run();
    });
  }

  private parseDurationSeconds(duration?: string): number | undefined {
    if (!duration) {
      return undefined;
    }

    const parts = duration.split(':');
    if (parts.length !== 3) {
      return undefined;
    }

    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);

    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds)
    ) {
      return undefined;
    }

    return Math.round(hours * 3600 + minutes * 60 + seconds);
  }
}

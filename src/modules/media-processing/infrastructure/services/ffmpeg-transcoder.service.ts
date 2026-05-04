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
    const hasAudioStream = await this.probeHasAudioStream(input.inputPath);

    return new Promise<Hls720pTranscodeResult>((resolve, reject) => {
      let durationSeconds: number | undefined;
      const stderrLines: string[] = [];

      ffmpeg(input.inputPath)
        .outputOptions(
          this.buildOutputOptions(input, hasAudioStream),
        )
        .output(input.variantPlaylistPath)
        .on('codecData', (data: { duration?: string }) => {
          durationSeconds = this.parseDurationSeconds(data.duration);
        })
        .on('stderr', (line: string) => {
          stderrLines.push(line.trim());
        })
        .on('end', () => resolve({ durationSeconds }))
        .on('error', (error: Error) => {
          const stderr = stderrLines.filter(Boolean).slice(-10).join('\n');
          const message =
            stderr.length > 0 ? `${error.message}\n${stderr}` : error.message;
          reject(new Error(message));
        })
        .run();
    });
  }

  private buildOutputOptions(
    input: Hls720pTranscodeInput,
    hasAudioStream: boolean,
  ): string[] {
    const outputOptions = [
      '-preset veryfast',
      '-g 48',
      '-sc_threshold 0',
      '-map 0:v:0',
      '-c:v:0 h264',
      '-b:v:0 2800k',
      '-maxrate:v:0 2996k',
      '-bufsize:v:0 4200k',
      '-s:v:0 1280x720',
      '-f hls',
      '-hls_time 6',
      '-hls_playlist_type vod',
      '-hls_segment_filename',
      input.segmentPattern,
      '-master_pl_name',
      basename(input.masterPlaylistPath),
    ];

    if (hasAudioStream) {
      outputOptions.push(
        '-map 0:a:0',
        '-c:a:0 aac',
        '-b:a:0 128k',
        '-var_stream_map',
        'v:0,a:0,name:720p',
      );
    } else {
      outputOptions.push('-var_stream_map', 'v:0,name:720p');
    }

    return outputOptions;
  }

  private async probeHasAudioStream(inputPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      ffmpeg.ffprobe(
        inputPath,
        (
          error: Error | undefined,
          data?: {
            streams?: Array<{ codec_type?: string }>;
          },
        ) => {
          if (error) {
            resolve(false);
            return;
          }

          const hasAudioStream =
            data?.streams?.some((stream) => stream.codec_type === 'audio') ??
            false;
          resolve(hasAudioStream);
        },
      );
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

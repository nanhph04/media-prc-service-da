import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';

export const TRANSCODE_RESOLUTION_PRESETS = [
  {
    name: '480p',
    width: 854,
    height: 480,
    videoBitrate: '1400k',
    maxRate: '1498k',
    bufferSize: '2100k',
    bandwidth: 1400000,
  },
  {
    name: '720p',
    width: 1280,
    height: 720,
    videoBitrate: '2800k',
    maxRate: '2996k',
    bufferSize: '4200k',
    bandwidth: 2800000,
  },
  {
    name: '1080p',
    width: 1920,
    height: 1080,
    videoBitrate: '5000k',
    maxRate: '5350k',
    bufferSize: '7500k',
    bandwidth: 5000000,
  },
] as const;

export type TranscodeResolutionName =
  (typeof TRANSCODE_RESOLUTION_PRESETS)[number]['name'];

export interface VideoProbeMetadata {
  durationSeconds?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  hasAudioStream: boolean;
}

export interface HlsVariantTranscodeInput {
  inputPath: string;
  outputDirectory: string;
  resolutions: TranscodeResolutionName[];
}

export interface HlsVariantTranscodeResult {
  durationSeconds?: number;
  resolutions: TranscodeResolutionName[];
}

export interface ThumbnailGenerationInput {
  inputPath: string;
  outputPath: string;
  durationSeconds?: number;
}

export interface ThumbnailGenerationResult {
  width: number;
  height: number;
  capturedAtSecond: number;
}

@Injectable()
export class FfmpegTranscoderService {
  constructor(private readonly configService: ConfigService) {
    const ffmpegPath = this.configService.get<string>('FFMPEG_PATH', '');

    if (ffmpegPath.length > 0) {
      ffmpeg.setFfmpegPath(ffmpegPath);
    }
  }

  async probeVideoMetadata(inputPath: string): Promise<VideoProbeMetadata> {
    return new Promise<VideoProbeMetadata>((resolve, reject) => {
      ffmpeg.ffprobe(
        inputPath,
        (
          error: Error | undefined,
          data?: {
            format?: { duration?: number };
            streams?: Array<{
              codec_type?: string;
              width?: number;
              height?: number;
            }>;
          },
        ) => {
          if (error) {
            reject(error);
            return;
          }

          const streams = data?.streams ?? [];
          const videoStream = streams.find(
            (stream) => stream.codec_type === 'video',
          );
          const durationSeconds = data?.format?.duration
            ? Math.round(data.format.duration)
            : undefined;

          resolve({
            durationSeconds,
            sourceWidth: videoStream?.width,
            sourceHeight: videoStream?.height,
            hasAudioStream: streams.some(
              (stream) => stream.codec_type === 'audio',
            ),
          });
        },
      );
    });
  }

  async transcodeToHlsVariants(
    input: HlsVariantTranscodeInput,
  ): Promise<HlsVariantTranscodeResult> {
    const metadata = await this.probeVideoMetadata(input.inputPath);
    await mkdir(input.outputDirectory, { recursive: true });
    await mkdir(join(input.outputDirectory, 'segments'), { recursive: true });

    for (const resolutionName of input.resolutions) {
      const preset = this.getPresetOrThrow(resolutionName);
      await this.transcodeSingleVariant(
        input.inputPath,
        input.outputDirectory,
        preset,
        metadata.hasAudioStream,
      );
    }

    await this.writeMasterPlaylist(input.outputDirectory, input.resolutions);

    return {
      durationSeconds: metadata.durationSeconds,
      resolutions: input.resolutions,
    };
  }

  async generateThumbnail(
    input: ThumbnailGenerationInput,
  ): Promise<ThumbnailGenerationResult> {
    await mkdir(dirname(input.outputPath), { recursive: true });
    const capturedAtSecond = this.resolveThumbnailCaptureSecond(
      input.durationSeconds,
    );

    return new Promise<ThumbnailGenerationResult>((resolve, reject) => {
      const stderrLines: string[] = [];

      ffmpeg(input.inputPath)
        .outputOptions([
          `-ss ${capturedAtSecond}`,
          '-frames:v 1',
          '-q:v 3',
          '-vf scale=w=1280:h=-2:force_original_aspect_ratio=decrease',
        ])
        .output(input.outputPath)
        .on('stderr', (line: string) => {
          stderrLines.push(line.trim());
        })
        .on('end', () => {
          void this.probeVideoMetadata(input.outputPath)
            .then((metadata) =>
              resolve({
                width: metadata.sourceWidth ?? 1280,
                height: metadata.sourceHeight ?? 0,
                capturedAtSecond,
              }),
            )
            .catch(() =>
              resolve({
                width: 1280,
                height: 0,
                capturedAtSecond,
              }),
            );
        })
        .on('error', (error: Error) => {
          const stderr = stderrLines.filter(Boolean).slice(-10).join('\n');
          const message =
            stderr.length > 0 ? `${error.message}\n${stderr}` : error.message;
          reject(new Error(message));
        })
        .run();
    });
  }

  private async transcodeSingleVariant(
    inputPath: string,
    outputDirectory: string,
    preset: (typeof TRANSCODE_RESOLUTION_PRESETS)[number],
    hasAudioStream: boolean,
  ): Promise<void> {
    const variantPlaylistPath = join(outputDirectory, `${preset.name}.m3u8`);
    const segmentPattern = join(
      outputDirectory,
      'segments',
      `${preset.name}_%03d.ts`,
    );

    await mkdir(dirname(segmentPattern), { recursive: true });

    return new Promise<void>((resolve, reject) => {
      const stderrLines: string[] = [];

      ffmpeg(inputPath)
        .outputOptions(
          this.buildOutputOptions(segmentPattern, preset, hasAudioStream),
        )
        .output(variantPlaylistPath)
        .on('stderr', (line: string) => {
          stderrLines.push(line.trim());
        })
        .on('end', () => resolve())
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
    segmentPattern: string,
    preset: (typeof TRANSCODE_RESOLUTION_PRESETS)[number],
    hasAudioStream: boolean,
  ): string[] {
    const outputOptions = [
      '-preset veryfast',
      '-g 48',
      '-sc_threshold 0',
      '-map 0:v:0',
      '-c:v:0 h264',
      `-b:v:0 ${preset.videoBitrate}`,
      `-maxrate:v:0 ${preset.maxRate}`,
      `-bufsize:v:0 ${preset.bufferSize}`,
      `-vf scale=w=${preset.width}:h=${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`,
      '-f hls',
      '-hls_time 6',
      '-hls_playlist_type vod',
      '-hls_segment_filename',
      segmentPattern,
    ];

    if (hasAudioStream) {
      outputOptions.push('-map 0:a:0', '-c:a:0 aac', '-b:a:0 128k');
    } else {
      outputOptions.push('-an');
    }

    return outputOptions;
  }

  private async writeMasterPlaylist(
    outputDirectory: string,
    resolutions: TranscodeResolutionName[],
  ): Promise<void> {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    for (const resolutionName of resolutions) {
      const preset = this.getPresetOrThrow(resolutionName);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${preset.bandwidth},RESOLUTION=${preset.width}x${preset.height}`,
        `${preset.name}.m3u8`,
      );
    }

    await writeFile(
      join(outputDirectory, 'master.m3u8'),
      `${lines.join('\n')}\n`,
      'utf8',
    );
  }

  private resolveThumbnailCaptureSecond(durationSeconds?: number): number {
    if (!durationSeconds || durationSeconds <= 1) {
      return 1;
    }

    return Math.max(1, Math.floor(durationSeconds * 0.1));
  }

  private getPresetOrThrow(
    resolutionName: TranscodeResolutionName,
  ): (typeof TRANSCODE_RESOLUTION_PRESETS)[number] {
    const preset = TRANSCODE_RESOLUTION_PRESETS.find(
      (candidate) => candidate.name === resolutionName,
    );

    if (!preset) {
      throw new Error(`Unsupported resolution preset: ${resolutionName}`);
    }

    return preset;
  }
}

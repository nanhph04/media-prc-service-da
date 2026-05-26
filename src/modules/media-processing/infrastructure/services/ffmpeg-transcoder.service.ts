import { Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';

const DEFAULT_HLS_SEGMENT_DURATION_SECONDS = 6;
const DEFAULT_TRANSCODE_PROGRESS_LOG_STEP_PERCENT = 10;

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
  videoId?: string;
  onProgress?: (progress: HlsTranscodeProgress) => void;
}

export interface HlsVariantTranscodeResult {
  durationSeconds?: number;
  resolutions: TranscodeResolutionName[];
}

export interface HlsTranscodeProgress {
  resolution: TranscodeResolutionName;
  progressPercent: number;
  overallProgressPercent: number;
  segmentIndex?: number;
  totalSegments?: number;
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
  private readonly logger = new Logger(FfmpegTranscoderService.name);
  private readonly hlsSegmentDurationSeconds: number;
  private readonly transcodeProgressLogStepPercent: number;

  constructor(private readonly configService: ConfigService) {
    const ffmpegPath = this.configService.get<string>('FFMPEG_PATH', '');
    this.hlsSegmentDurationSeconds = this.getPositiveNumberConfig(
      'HLS_SEGMENT_DURATION_SECONDS',
      DEFAULT_HLS_SEGMENT_DURATION_SECONDS,
    );
    this.transcodeProgressLogStepPercent = this.getPositiveNumberConfig(
      'TRANSCODE_PROGRESS_LOG_STEP_PERCENT',
      DEFAULT_TRANSCODE_PROGRESS_LOG_STEP_PERCENT,
    );

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
    const totalSegments = this.estimateTotalSegments(metadata.durationSeconds);

    for (const [variantIndex, resolutionName] of input.resolutions.entries()) {
      const preset = this.getPresetOrThrow(resolutionName);
      this.logger.log(
        this.buildTranscodeStartMessage(
          input.videoId,
          resolutionName,
          totalSegments,
        ),
      );
      await this.transcodeSingleVariant(
        input.inputPath,
        input.outputDirectory,
        preset,
        metadata.hasAudioStream,
        metadata.durationSeconds,
        totalSegments,
        input.videoId,
        (progress) => {
          const overallProgressPercent = this.calculateOverallProgressPercent(
            variantIndex,
            input.resolutions.length,
            progress.progressPercent,
          );
          input.onProgress?.({
            ...progress,
            overallProgressPercent,
          });
        },
      );
      this.logger.log(
        this.buildTranscodeCompleteMessage(
          input.videoId,
          resolutionName,
          totalSegments,
        ),
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
    durationSeconds: number | undefined,
    totalSegments: number | undefined,
    videoId: string | undefined,
    onProgress: (
      progress: Omit<HlsTranscodeProgress, 'overallProgressPercent'>,
    ) => void,
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
      const progressLogState = {
        lastLoggedStepPercent: 0,
      };

      ffmpeg(inputPath)
        .outputOptions(
          this.buildOutputOptions(segmentPattern, preset, hasAudioStream),
        )
        .output(variantPlaylistPath)
        .on('stderr', (line: string) => {
          stderrLines.push(line.trim());
        })
        .on('progress', (progress: FfmpegProgressPayload) => {
          const resolvedProgress = this.resolveHlsProgress(
            progress,
            preset.name,
            durationSeconds,
            totalSegments,
          );
          if (!resolvedProgress) {
            return;
          }

          if (
            this.shouldLogProgress(
              resolvedProgress.progressPercent,
              progressLogState.lastLoggedStepPercent,
            )
          ) {
            progressLogState.lastLoggedStepPercent = this.toProgressStepPercent(
              resolvedProgress.progressPercent,
            );
            this.logger.log(
              this.buildTranscodeProgressMessage(videoId, resolvedProgress),
            );
            onProgress(resolvedProgress);
          }
        })
        .on('end', () => {
          onProgress({
            resolution: preset.name,
            progressPercent: 100,
            segmentIndex: totalSegments,
            totalSegments,
          });
          resolve();
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
      `-hls_time ${this.hlsSegmentDurationSeconds}`,
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

  private estimateTotalSegments(durationSeconds?: number): number | undefined {
    if (durationSeconds === undefined || durationSeconds <= 0) {
      return undefined;
    }

    return Math.ceil(durationSeconds / this.hlsSegmentDurationSeconds);
  }

  private resolveHlsProgress(
    progress: FfmpegProgressPayload,
    resolution: TranscodeResolutionName,
    durationSeconds: number | undefined,
    totalSegments: number | undefined,
  ): Omit<HlsTranscodeProgress, 'overallProgressPercent'> | undefined {
    const elapsedSeconds = this.parseTimemarkToSeconds(progress.timemark);
    const progressPercent = this.resolveProgressPercent(
      progress.percent,
      elapsedSeconds,
      durationSeconds,
    );

    if (progressPercent === undefined) {
      return undefined;
    }

    const segmentIndex =
      elapsedSeconds !== undefined && totalSegments !== undefined
        ? Math.min(
            totalSegments,
            Math.max(
              0,
              Math.ceil(elapsedSeconds / this.hlsSegmentDurationSeconds),
            ),
          )
        : undefined;

    return {
      resolution,
      progressPercent,
      segmentIndex,
      totalSegments,
    };
  }

  private resolveProgressPercent(
    ffmpegPercent: number | undefined,
    elapsedSeconds: number | undefined,
    durationSeconds: number | undefined,
  ): number | undefined {
    const rawPercent =
      ffmpegPercent ??
      (elapsedSeconds !== undefined &&
      durationSeconds !== undefined &&
      durationSeconds > 0
        ? (elapsedSeconds / durationSeconds) * 100
        : undefined);

    if (rawPercent === undefined || !Number.isFinite(rawPercent)) {
      return undefined;
    }

    return Math.min(100, Math.max(0, Math.round(rawPercent)));
  }

  private parseTimemarkToSeconds(timemark?: string): number | undefined {
    if (!timemark) {
      return undefined;
    }

    const parts = timemark.split(':');
    if (parts.length !== 3) {
      return undefined;
    }

    const [hours, minutes, seconds] = parts.map(Number);
    if (
      hours === undefined ||
      minutes === undefined ||
      seconds === undefined ||
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds)
    ) {
      return undefined;
    }

    return hours * 3600 + minutes * 60 + seconds;
  }

  private shouldLogProgress(
    progressPercent: number,
    lastLoggedStepPercent: number,
  ): boolean {
    const currentStepPercent = this.toProgressStepPercent(progressPercent);

    return currentStepPercent > 0 && currentStepPercent > lastLoggedStepPercent;
  }

  private toProgressStepPercent(progressPercent: number): number {
    return (
      Math.floor(progressPercent / this.transcodeProgressLogStepPercent) *
      this.transcodeProgressLogStepPercent
    );
  }

  private calculateOverallProgressPercent(
    variantIndex: number,
    variantCount: number,
    variantProgressPercent: number,
  ): number {
    if (variantCount <= 0) {
      return 0;
    }

    return Math.round(
      ((variantIndex + variantProgressPercent / 100) / variantCount) * 100,
    );
  }

  private buildTranscodeStartMessage(
    videoId: string | undefined,
    resolution: TranscodeResolutionName,
    totalSegments: number | undefined,
  ): string {
    return [
      'Starting HLS transcode',
      this.formatVideoId(videoId),
      `resolution=${resolution}`,
      this.formatEstimatedSegments(totalSegments),
    ]
      .filter(Boolean)
      .join(' ');
  }

  private buildTranscodeProgressMessage(
    videoId: string | undefined,
    progress: Omit<HlsTranscodeProgress, 'overallProgressPercent'>,
  ): string {
    return [
      'HLS transcode progress',
      this.formatVideoId(videoId),
      `resolution=${progress.resolution}`,
      `progress=${progress.progressPercent}%`,
      this.formatSegmentProgress(progress.segmentIndex, progress.totalSegments),
    ]
      .filter(Boolean)
      .join(' ');
  }

  private buildTranscodeCompleteMessage(
    videoId: string | undefined,
    resolution: TranscodeResolutionName,
    totalSegments: number | undefined,
  ): string {
    return [
      'Completed HLS transcode',
      this.formatVideoId(videoId),
      `resolution=${resolution}`,
      this.formatEstimatedSegments(totalSegments),
    ]
      .filter(Boolean)
      .join(' ');
  }

  private formatVideoId(videoId?: string): string {
    return videoId ? `videoId=${videoId}` : '';
  }

  private formatEstimatedSegments(totalSegments?: number): string {
    return totalSegments !== undefined
      ? `estimatedSegments=${totalSegments}`
      : '';
  }

  private formatSegmentProgress(
    segmentIndex?: number,
    totalSegments?: number,
  ): string {
    return segmentIndex !== undefined && totalSegments !== undefined
      ? `segment=${segmentIndex}/${totalSegments}`
      : '';
  }

  private getPositiveNumberConfig(key: string, defaultValue: number): number {
    const value = this.configService.get<number>(key, defaultValue);

    return Number.isFinite(value) && value > 0 ? value : defaultValue;
  }
}

interface FfmpegProgressPayload {
  percent?: number;
  timemark?: string;
}

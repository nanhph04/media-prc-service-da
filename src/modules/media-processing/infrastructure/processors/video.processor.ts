import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import type { VideoProcessingJobData } from '../../application/dtos/video-processing-job-data.dto';
import {
  getRedisQueueOptions,
  TRANSCODE_JOB_NAME,
} from '../config/media-processing.config';
import { KafkaEventPublisher } from '../messaging/kafka-event-publisher';
import {
  FfmpegTranscoderService,
  TRANSCODE_RESOLUTION_PRESETS,
  type TranscodeResolutionName,
} from '../services/ffmpeg-transcoder.service';
import { MinioStorageService } from '../storage/minio-storage.service';

@Injectable()
export class VideoProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessor.name);

  private worker?: Worker<VideoProcessingJobData>;

  constructor(
    private readonly storageService: MinioStorageService,
    private readonly transcoderService: FfmpegTranscoderService,
    private readonly eventPublisher: KafkaEventPublisher,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const queueOptions = getRedisQueueOptions(this.configService);
    this.worker = new Worker<VideoProcessingJobData>(
      queueOptions.queueName,
      async (job) => this.handleVideoProcessing(job),
      {
        connection: queueOptions.connection,
      },
    );
    this.worker.on('failed', (job, error) => {
      void this.publishFinalFailureIfNeeded(job, error);
    });
  }

  isReady(): boolean {
    return this.worker !== undefined;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async handleVideoProcessing(job: Job<VideoProcessingJobData>): Promise<void> {
    if (job.name !== TRANSCODE_JOB_NAME) {
      this.logger.warn(`Skipping unsupported video job name=${job.name}`);
      return;
    }

    const { rawFileKey, videoId, traceId } = job.data;
    const paths = this.storageService.createWorkPaths(videoId);

    try {
      await job.updateProgress(5);
      this.logger.log(
        `Starting video processing for videoId=${videoId}, rawFileKey=${rawFileKey}`,
      );

      await this.storageService.downloadRawVideo(rawFileKey, paths.inputPath);
      await job.updateProgress(15);

      const metadata = await this.transcoderService.probeVideoMetadata(
        paths.inputPath,
      );
      this.assertDurationWithinLimit(metadata.durationSeconds);
      const normalizedResolutions = this.normalizeRequestedResolutions(
        job.data.resolution,
        metadata.sourceHeight,
      );
      await job.updateProgress(35);

      const transcodeResult =
        await this.transcoderService.transcodeToHlsVariants({
          inputPath: paths.inputPath,
          outputDirectory: paths.outputDirectory,
          resolutions: normalizedResolutions,
        });

      await job.updateProgress(75);

      const uploadedOutput = await this.storageService.uploadHlsOutput(
        videoId,
        paths.outputDirectory,
        transcodeResult.resolutions,
      );

      await job.updateProgress(90);
      await this.eventPublisher.publishVideoProcessedSuccess({
        videoId,
        traceId,
        masterPlaylistKey: uploadedOutput.masterPlaylistKey,
        durationSeconds: transcodeResult.durationSeconds,
        resolution: uploadedOutput.resolution,
      });
      await job.updateProgress(100);

      this.logger.log(`Completed video processing for videoId=${videoId}`);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown video processing error';
      const stack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        `Failed video processing for videoId=${videoId}, rawFileKey=${rawFileKey}: ${message}`,
        stack,
      );

      throw error;
    } finally {
      await this.storageService.cleanupLocalDirectory(paths.workDirectory);
    }
  }

  private async publishFinalFailureIfNeeded(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || job.name !== TRANSCODE_JOB_NAME) {
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Video processing attempt failed for videoId=${job.data.videoId}; retrying attempt ${job.attemptsMade + 1}/${maxAttempts}`,
      );
      return;
    }

    const errorMessage =
      maxAttempts > 1
        ? `Video processing failed after ${maxAttempts} attempts: ${error.message}`
        : error.message;

    await this.eventPublisher.publishVideoProcessedFailed({
      videoId: job.data.videoId,
      traceId: job.data.traceId,
      errorMessage,
    });
  }

  private assertDurationWithinLimit(durationSeconds?: number): void {
    if (durationSeconds === undefined) {
      return;
    }

    const maxDurationSeconds = this.configService.getMaxVideoDurationSeconds();
    if (durationSeconds > maxDurationSeconds) {
      throw new Error('Video duration exceeds maximum limit of 4 hours');
    }
  }

  private normalizeRequestedResolutions(
    requestedResolutions: string[],
    sourceHeight?: number,
  ): TranscodeResolutionName[] {
    if (sourceHeight === undefined || sourceHeight < 480) {
      throw new Error(
        'Video source resolution is lower than minimum supported 480p',
      );
    }

    const requestedHeights = requestedResolutions
      .map((resolution) =>
        TRANSCODE_RESOLUTION_PRESETS.find(
          (preset) => preset.name === resolution,
        ),
      )
      .filter(
        (preset): preset is (typeof TRANSCODE_RESOLUTION_PRESETS)[number] =>
          preset !== undefined,
      )
      .map((preset) => preset.height);

    const normalizedResolutions = new Set<TranscodeResolutionName>();
    for (const requestedHeight of requestedHeights) {
      const targetPreset = [...TRANSCODE_RESOLUTION_PRESETS]
        .reverse()
        .find(
          (preset) => preset.height <= Math.min(requestedHeight, sourceHeight),
        );

      if (targetPreset) {
        normalizedResolutions.add(targetPreset.name);
      }
    }

    const orderedResolutions = TRANSCODE_RESOLUTION_PRESETS.filter((preset) =>
      normalizedResolutions.has(preset.name),
    ).map((preset) => preset.name);

    if (orderedResolutions.length === 0) {
      throw new Error(
        'Video source resolution is lower than minimum supported 480p',
      );
    }

    return orderedResolutions;
  }

}

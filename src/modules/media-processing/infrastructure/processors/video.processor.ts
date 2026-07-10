import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import { VIDEO_PROCESSING_ERROR_MESSAGES } from '../../application/constants/video-processing-errors.constant';
import type { VideoProcessingJobData } from '../../application/dtos/video-processing-job-data.dto';
import {
  getRedisQueueOptions,
  TRANSCODE_JOB_NAME,
} from '../config/media-processing.config';
import { KafkaEventPublisher } from '../messaging/kafka-event-publisher';
import { VideoProcessingFailureNotificationQueue } from '../queue/video-processing-failure-notification.queue';
import {
  FfmpegTranscoderService,
  type HlsTranscodeProgress,
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
    @Optional()
    private readonly failureNotificationQueue?: VideoProcessingFailureNotificationQueue,
  ) {}

  onModuleInit(): void {
    const queueOptions = getRedisQueueOptions(this.configService);
    this.worker = new Worker<VideoProcessingJobData>(
      queueOptions.queueName,
      async (job) => this.handleVideoProcessing(job),
      {
        connection: queueOptions.connection,
        concurrency: queueOptions.workerConcurrency,
      },
    );
    this.logger.log(
      `Video processing worker started queue=${queueOptions.queueName}, concurrency=${queueOptions.workerConcurrency}`,
    );
    this.worker.on('failed', (job, error) => {
      void this.publishFinalFailureIfNeeded(job, error).catch(
        (publishError: unknown) => {
          const message =
            publishError instanceof Error
              ? publishError.message
              : VIDEO_PROCESSING_ERROR_MESSAGES.UNKNOWN_PROCESSING_ERROR;
          this.logger.error(
            `Failed to enqueue final video processing failure notification: ${message}`,
            publishError instanceof Error ? publishError.stack : undefined,
          );
        },
      );
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
      await this.storageService.cleanupLocalDirectory(paths.workDirectory);
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
      await this.generateThumbnailIfRequested(
        job,
        paths,
        metadata.durationSeconds,
      );
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
          videoId,
          onProgress: (progress) => {
            this.updateHlsJobProgress(job, progress);
          },
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
          : VIDEO_PROCESSING_ERROR_MESSAGES.UNKNOWN_PROCESSING_ERROR;
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

    if (!this.failureNotificationQueue) {
      throw new Error('Failure notification queue is not configured');
    }

    await this.failureNotificationQueue.enqueueFinalFailure({
      videoId: job.data.videoId,
      traceId: job.data.traceId,
      errorMessage,
      shouldPublishThumbnailFailed: Boolean(job.data.thumbnailTargetObjectKey),
    });
  }

  private async generateThumbnailIfRequested(
    job: Job<VideoProcessingJobData>,
    paths: ReturnType<MinioStorageService['createWorkPaths']>,
    durationSeconds?: number,
  ): Promise<void> {
    const thumbnailTargetObjectKey = job.data.thumbnailTargetObjectKey;
    if (!thumbnailTargetObjectKey) {
      return;
    }
    const thumbnailTargetBucket =
      job.data.thumbnailTargetBucket ??
      this.storageService.getDefaultThumbnailBucket();

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const thumbnail = await this.transcoderService.generateThumbnail({
          inputPath: paths.inputPath,
          outputPath: paths.thumbnailPath,
          durationSeconds,
        });
        const uploadedThumbnail = await this.storageService.uploadThumbnail(
          thumbnailTargetBucket,
          thumbnailTargetObjectKey,
          paths.thumbnailPath,
        );
        await this.eventPublisher.publishVideoThumbnailGenerated({
          videoId: job.data.videoId,
          traceId: job.data.traceId,
          thumbnailObjectKey: uploadedThumbnail.objectKey,
          thumbnailUrl: uploadedThumbnail.url,
          width: thumbnail.width,
          height: thumbnail.height,
          capturedAtSecond: thumbnail.capturedAtSecond,
        });
        return;
      } catch (error: unknown) {
        lastError = error;
        const message =
          error instanceof Error
            ? error.message
            : VIDEO_PROCESSING_ERROR_MESSAGES.UNKNOWN_THUMBNAIL_ERROR;
        this.logger.warn(
          `Thumbnail generation attempt ${attempt}/3 failed for videoId=${job.data.videoId}: ${message}`,
        );
      }
    }

    const message =
      lastError instanceof Error
        ? lastError.message
        : VIDEO_PROCESSING_ERROR_MESSAGES.UNKNOWN_THUMBNAIL_ERROR;
    await this.eventPublisher.publishVideoThumbnailFailed({
      videoId: job.data.videoId,
      traceId: job.data.traceId,
      reasonCode: 'FFMPEG_FAILED',
      message,
      retryable: false,
    });
  }

  private assertDurationWithinLimit(durationSeconds?: number): void {
    if (durationSeconds === undefined) {
      return;
    }

    const maxDurationSeconds = this.configService.getMaxVideoDurationSeconds();
    if (durationSeconds > maxDurationSeconds) {
      throw new Error(VIDEO_PROCESSING_ERROR_MESSAGES.DURATION_EXCEEDS_LIMIT);
    }
  }

  private normalizeRequestedResolutions(
    requestedResolutions: string[],
    sourceHeight?: number,
  ): TranscodeResolutionName[] {
    if (sourceHeight === undefined || sourceHeight < 480) {
      throw new Error(
        VIDEO_PROCESSING_ERROR_MESSAGES.SOURCE_RESOLUTION_BELOW_MINIMUM,
      );
    }

    if (requestedResolutions.length === 0) {
      throw new Error(
        VIDEO_PROCESSING_ERROR_MESSAGES.REQUESTED_RESOLUTIONS_REQUIRED,
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
        VIDEO_PROCESSING_ERROR_MESSAGES.REQUESTED_RESOLUTIONS_UNSUPPORTED,
      );
    }

    return orderedResolutions;
  }

  private mapHlsProgressToJobProgress(progress: HlsTranscodeProgress): number {
    const transcodeStartProgress = 35;
    const transcodeEndProgress = 75;
    const transcodeProgressRange =
      transcodeEndProgress - transcodeStartProgress;

    return Math.min(
      transcodeEndProgress,
      Math.max(
        transcodeStartProgress,
        Math.round(
          transcodeStartProgress +
            (progress.overallProgressPercent / 100) * transcodeProgressRange,
        ),
      ),
    );
  }

  private updateHlsJobProgress(
    job: Job<VideoProcessingJobData>,
    progress: HlsTranscodeProgress,
  ): void {
    const jobProgress = this.mapHlsProgressToJobProgress(progress);

    void job.updateProgress(jobProgress).catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : VIDEO_PROCESSING_ERROR_MESSAGES.UNKNOWN_PROCESSING_ERROR;
      this.logger.warn(
        `Failed to update video processing progress for videoId=${job.data.videoId}, progress=${jobProgress}: ${message}`,
      );
    });
  }
}

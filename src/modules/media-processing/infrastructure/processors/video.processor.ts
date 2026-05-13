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
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'queued',
        percent: 5,
        message: 'Video queued for processing',
        terminal: false,
      });
      this.logProgress(videoId, 'queued', 5, false);
      this.logger.log(
        `Starting video processing for videoId=${videoId}, rawFileKey=${rawFileKey}`,
      );

      await this.storageService.downloadRawVideo(rawFileKey, paths.inputPath);
      await job.updateProgress(15);
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'downloading',
        percent: 15,
        message: 'Raw video downloaded',
        terminal: false,
      });
      this.logProgress(videoId, 'downloading', 15, false);

      const metadata = await this.transcoderService.probeVideoMetadata(
        paths.inputPath,
      );
      this.assertDurationWithinLimit(metadata.durationSeconds);
      const normalizedResolutions = this.normalizeRequestedResolutions(
        job.data.resolution,
        metadata.sourceHeight,
      );
      await job.updateProgress(35);
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'probing',
        percent: 35,
        message: 'Video metadata analyzed',
        terminal: false,
      });
      this.logProgress(videoId, 'probing', 35, false);

      const transcodeResult =
        await this.transcoderService.transcodeToHlsVariants({
          inputPath: paths.inputPath,
          outputDirectory: paths.outputDirectory,
          resolutions: normalizedResolutions,
        });

      await job.updateProgress(75);
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'transcoding',
        percent: 75,
        message: 'HLS variants created',
        terminal: false,
      });
      this.logProgress(videoId, 'transcoding', 75, false);

      const uploadedOutput = await this.storageService.uploadHlsOutput(
        videoId,
        paths.outputDirectory,
        transcodeResult.resolutions,
      );

      await job.updateProgress(90);
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'uploading',
        percent: 90,
        message: 'Processed assets uploaded',
        terminal: false,
      });
      this.logProgress(videoId, 'uploading', 90, false);
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'finalizing',
        percent: 95,
        message: 'Finalizing processing',
        terminal: false,
      });
      this.logProgress(videoId, 'finalizing', 95, false);
      await this.eventPublisher.publishVideoProcessedSuccess({
        videoId,
        traceId,
        masterPlaylistKey: uploadedOutput.masterPlaylistKey,
        durationSeconds: transcodeResult.durationSeconds,
        resolution: uploadedOutput.resolution,
      });
      await job.updateProgress(100);
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'completed',
        percent: 100,
        message: 'Video processing completed',
        terminal: true,
      });
      this.logProgress(videoId, 'completed', 100, true);

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

      await this.eventPublisher.publishVideoProcessedFailed({
        videoId,
        traceId,
        errorMessage: message,
      });
      await this.eventPublisher.publishVideoProgressUpdated({
        videoId,
        traceId,
        pipeline: 'processing',
        stage: 'failed',
        percent: 100,
        message,
        terminal: true,
        errorMessage: message,
      });
      this.logProgress(videoId, 'failed', 100, true);

      throw error;
    } finally {
      await this.storageService.cleanupLocalDirectory(paths.workDirectory);
    }
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

  private logProgress(
    videoId: string,
    stage: string,
    percent: number,
    terminal: boolean,
  ): void {
    this.logger.log(
      `Published processing progress for videoId=${videoId}, stage=${stage}, percent=${percent}, terminal=${terminal}`,
    );
  }
}

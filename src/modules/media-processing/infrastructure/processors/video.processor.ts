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
import { FfmpegTranscoderService } from '../services/ffmpeg-transcoder.service';
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
      this.logger.log(
        `Starting video processing for videoId=${videoId}, rawFileKey=${rawFileKey}`,
      );

      await this.storageService.downloadRawVideo(rawFileKey, paths.inputPath);
      await job.updateProgress(15);

      await job.updateProgress(35);
      const transcodeResult = await this.transcoderService.convertMp4ToHls720p({
        inputPath: paths.inputPath,
        masterPlaylistPath: paths.masterPlaylistPath,
        variantPlaylistPath: paths.variantPlaylistPath,
        segmentPattern: paths.segmentPattern,
      });

      await job.updateProgress(75);

      const uploadedOutput = await this.storageService.uploadHlsOutput(
        videoId,
        paths.outputDirectory,
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

      await this.eventPublisher.publishVideoProcessedFailed({
        videoId,
        traceId,
        errorMessage: message,
      });

      throw error;
    } finally {
      await this.storageService.cleanupLocalDirectory(paths.workDirectory);
    }
  }
}

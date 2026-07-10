import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type JobsOptions, type Job } from 'bullmq';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import { getRedisQueueOptions } from '../config/media-processing.config';
import { KafkaEventPublisher } from '../messaging/kafka-event-publisher';

const FINAL_FAILURE_NOTIFICATION_QUEUE_NAME =
  'video-processing-failure-notifications';
const PROCESSED_FAILED_JOB_NAME = 'publish-video-processed-failed';
const THUMBNAIL_FAILED_JOB_NAME = 'publish-video-thumbnail-failed';
const COMPLETED_NOTIFICATION_RETENTION_SECONDS = 24 * 60 * 60;

export interface EnqueueFinalFailureNotificationInput {
  videoId: string;
  traceId?: string;
  errorMessage: string;
  shouldPublishThumbnailFailed: boolean;
}

type FailureNotificationJobData = {
  videoId: string;
  traceId?: string;
  errorMessage: string;
};

@Injectable()
export class VideoProcessingFailureNotificationQueue implements OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessingFailureNotificationQueue.name);
  private readonly queue: Queue<FailureNotificationJobData>;
  private readonly worker: Worker<FailureNotificationJobData>;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventPublisher: KafkaEventPublisher,
  ) {
    const queueOptions = getRedisQueueOptions(this.configService);
    const queueName = this.configService.get<string>(
      'BULLMQ_FAILURE_NOTIFICATION_QUEUE_NAME',
      FINAL_FAILURE_NOTIFICATION_QUEUE_NAME,
    );

    this.queue = new Queue<FailureNotificationJobData>(queueName, {
      connection: queueOptions.connection,
    });
    this.worker = new Worker<FailureNotificationJobData>(
      queueName,
      async (job) => this.publishNotification(job),
      {
        connection: queueOptions.connection,
        concurrency: 1,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Failure notification job failed | jobId=${job?.id} | name=${job?.name} | videoId=${job?.data.videoId}: ${error.message}`,
        error.stack,
      );
    });
  }

  async enqueueFinalFailure(
    input: EnqueueFinalFailureNotificationInput,
  ): Promise<void> {
    await this.queue.add(
      PROCESSED_FAILED_JOB_NAME,
      {
        videoId: input.videoId,
        traceId: input.traceId,
        errorMessage: input.errorMessage,
      },
      this.createJobOptions(`processed-failed-${input.videoId}`),
    );

    if (!input.shouldPublishThumbnailFailed) {
      return;
    }

    await this.queue.add(
      THUMBNAIL_FAILED_JOB_NAME,
      {
        videoId: input.videoId,
        traceId: input.traceId,
        errorMessage: input.errorMessage,
      },
      this.createJobOptions(`thumbnail-failed-${input.videoId}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }

  private async publishNotification(
    job: Job<FailureNotificationJobData>,
  ): Promise<void> {
    if (job.name === PROCESSED_FAILED_JOB_NAME) {
      await this.eventPublisher.publishVideoProcessedFailed({
        videoId: job.data.videoId,
        traceId: job.data.traceId,
        errorMessage: job.data.errorMessage,
      });
      return;
    }

    if (job.name === THUMBNAIL_FAILED_JOB_NAME) {
      await this.eventPublisher.publishVideoThumbnailFailed({
        videoId: job.data.videoId,
        traceId: job.data.traceId,
        reasonCode: 'UNKNOWN',
        message: job.data.errorMessage,
        retryable: false,
      });
      return;
    }

    this.logger.warn(`Skipping unsupported failure notification job name=${job.name}`);
  }

  private createJobOptions(jobId: string): JobsOptions {
    return {
      jobId,
      attempts: this.configService.get<number>(
        'MEDIA_PROCESSING_FAILURE_NOTIFICATION_ATTEMPTS',
        10,
      ),
      backoff: {
        type: 'exponential',
        delay: this.configService.get<number>(
          'MEDIA_PROCESSING_FAILURE_NOTIFICATION_BACKOFF_MS',
          5000,
        ),
      },
      removeOnComplete: {
        age: COMPLETED_NOTIFICATION_RETENTION_SECONDS,
        count: 1000,
      },
      removeOnFail: 1000,
    };
  }
}

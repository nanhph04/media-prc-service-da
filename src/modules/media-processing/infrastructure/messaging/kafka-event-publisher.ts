import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import { lastValueFrom } from 'rxjs';
import type { IIntegrationEvent } from '../../../../shared/domain/types/events/base-integration.event';
import type { VideoProcessedFailedEventData } from '../../application/dtos/video-processed-failed.event-data';
import type { VideoProcessedSuccessEventData } from '../../application/dtos/video-processed-success.event-data';
import type { VideoThumbnailFailedEventData } from '../../application/dtos/video-thumbnail-failed.event-data';
import type { VideoThumbnailGeneratedEventData } from '../../application/dtos/video-thumbnail-generated.event-data';
import {
  KAFKA_EVENT_PUBLISHER_OPTIONS,
  type KafkaEventPublisherOptions,
} from '../config/media-processing.config';
import { MEDIA_EVENTS_CLIENT } from './media-events.constants';

export interface PublishVideoProcessedSuccessInput extends VideoProcessedSuccessEventData {
  traceId?: string;
}

export interface PublishVideoProcessedFailedInput extends VideoProcessedFailedEventData {
  traceId?: string;
}

export interface PublishVideoThumbnailGeneratedInput
  extends VideoThumbnailGeneratedEventData {
  traceId?: string;
}

export interface PublishVideoThumbnailFailedInput
  extends VideoThumbnailFailedEventData {
  traceId?: string;
}

@Injectable()
export class KafkaEventPublisher implements OnModuleInit, OnModuleDestroy {
  private static readonly MAX_RETRIES = 3;

  private readonly logger = new Logger(KafkaEventPublisher.name);
  private readonly options: KafkaEventPublisherOptions;

  constructor(
    @Inject(MEDIA_EVENTS_CLIENT)
    private readonly kafkaClient: ClientKafka,
    @Optional()
    @Inject(KAFKA_EVENT_PUBLISHER_OPTIONS)
    options?: KafkaEventPublisherOptions,
  ) {
    this.options = options ?? {
      successTopic: 'video.processed.success',
      failedTopic: 'video.processed.failed',
      thumbnailGeneratedTopic: 'video.thumbnail.generated',
      thumbnailFailedTopic: 'video.thumbnail.failed',
    };
  }

  async onModuleInit(): Promise<void> {
    await this.kafkaClient.connect();
    this.logger.log(
      `Kafka publisher connected | successTopic=${this.options.successTopic} | failedTopic=${this.options.failedTopic}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.kafkaClient.close();
    this.logger.log('Kafka publisher closed');
  }

  async publishVideoProcessedSuccess(
    input: PublishVideoProcessedSuccessInput,
  ): Promise<void> {
    const event: IIntegrationEvent<VideoProcessedSuccessEventData> = {
      eventId: randomUUID(),
      eventType: this.options.successTopic,
      aggregateId: input.videoId,
      timestamp: new Date().toISOString(),
      version: 1,
      traceId: input.traceId ?? randomUUID(),
      sourceService: 'media-processing-service',
      data: {
        videoId: input.videoId,
        masterPlaylistKey: input.masterPlaylistKey,
        durationSeconds: input.durationSeconds,
        thumbnailUrl: input.thumbnailUrl,
        resolution: input.resolution,
      },
    };

    await this.publish(this.options.successTopic, event, {
      kind: 'success',
      videoId: input.videoId,
    });
  }

  async publishVideoProcessedFailed(
    input: PublishVideoProcessedFailedInput,
  ): Promise<void> {
    const event: IIntegrationEvent<VideoProcessedFailedEventData> = {
      eventId: randomUUID(),
      eventType: this.options.failedTopic,
      aggregateId: input.videoId,
      timestamp: new Date().toISOString(),
      version: 1,
      traceId: input.traceId ?? randomUUID(),
      sourceService: 'media-processing-service',
      data: {
        videoId: input.videoId,
        errorMessage: input.errorMessage,
      },
    };

    await this.publish(this.options.failedTopic, event, {
      kind: 'failed',
      videoId: input.videoId,
    });
  }

  async publishVideoThumbnailGenerated(
    input: PublishVideoThumbnailGeneratedInput,
  ): Promise<void> {
    const event: IIntegrationEvent<VideoThumbnailGeneratedEventData> = {
      eventId: randomUUID(),
      eventType: this.options.thumbnailGeneratedTopic,
      aggregateId: input.videoId,
      timestamp: new Date().toISOString(),
      version: 1,
      traceId: input.traceId ?? randomUUID(),
      sourceService: 'media-processing-service',
      data: {
        videoId: input.videoId,
        thumbnailObjectKey: input.thumbnailObjectKey,
        thumbnailUrl: input.thumbnailUrl,
        width: input.width,
        height: input.height,
        capturedAtSecond: input.capturedAtSecond,
      },
    };

    await this.publish(this.options.thumbnailGeneratedTopic, event, {
      kind: 'thumbnail-generated',
      videoId: input.videoId,
    });
  }

  async publishVideoThumbnailFailed(
    input: PublishVideoThumbnailFailedInput,
  ): Promise<void> {
    const event: IIntegrationEvent<VideoThumbnailFailedEventData> = {
      eventId: randomUUID(),
      eventType: this.options.thumbnailFailedTopic,
      aggregateId: input.videoId,
      timestamp: new Date().toISOString(),
      version: 1,
      traceId: input.traceId ?? randomUUID(),
      sourceService: 'media-processing-service',
      data: {
        videoId: input.videoId,
        reasonCode: input.reasonCode,
        message: input.message,
        retryable: input.retryable,
      },
    };

    await this.publish(this.options.thumbnailFailedTopic, event, {
      kind: 'thumbnail-failed',
      videoId: input.videoId,
    });
  }

  private async publish<T>(
    topic: string,
    event: IIntegrationEvent<T>,
    meta: Record<string, unknown>,
  ): Promise<void> {
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= KafkaEventPublisher.MAX_RETRIES;
      attempt += 1
    ) {
      try {
        this.logger.log(
          `Publishing Kafka event | topic=${topic} | eventId=${event.eventId} | attempt=${attempt} | meta=${JSON.stringify(meta)}`,
        );
        await lastValueFrom(this.kafkaClient.emit(topic, event));
        this.logger.log(
          `Published Kafka event | topic=${topic} | eventId=${event.eventId} | meta=${JSON.stringify(meta)}`,
        );
        return;
      } catch (error: unknown) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Kafka publish failed | topic=${topic} | eventId=${event.eventId} | attempt=${attempt} | error=${message}`,
        );
      }
    }

    throw lastError;
  }
}

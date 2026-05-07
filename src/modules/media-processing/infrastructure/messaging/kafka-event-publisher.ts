import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import { lastValueFrom } from 'rxjs';
import type { IIntegrationEvent } from '../../../../shared/domain/types/events/base-integration.event';
import type { VideoProcessedFailedEventData } from '../../application/dtos/video-processed-failed.event-data';
import type { VideoProgressUpdatedEventData } from '../../application/dtos/video-progress-updated.event-data';
import type { VideoProcessedSuccessEventData } from '../../application/dtos/video-processed-success.event-data';
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

export interface PublishVideoProgressUpdatedInput
  extends VideoProgressUpdatedEventData {
  traceId?: string;
}

@Injectable()
export class KafkaEventPublisher implements OnModuleInit, OnModuleDestroy {
  private static readonly MAX_RETRIES = 3;

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
      progressTopic: 'video.progress.updated',
    };
  }

  async onModuleInit(): Promise<void> {
    await this.kafkaClient.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.kafkaClient.close();
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

    await this.publish(this.options.successTopic, event);
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

    await this.publish(this.options.failedTopic, event);
  }

  async publishVideoProgressUpdated(
    input: PublishVideoProgressUpdatedInput,
  ): Promise<void> {
    const event: IIntegrationEvent<VideoProgressUpdatedEventData> = {
      eventId: randomUUID(),
      eventType: this.options.progressTopic,
      aggregateId: input.videoId,
      timestamp: new Date().toISOString(),
      version: 1,
      traceId: input.traceId ?? randomUUID(),
      sourceService: 'media-processing-service',
      data: {
        videoId: input.videoId,
        pipeline: 'processing',
        stage: input.stage,
        percent: input.percent,
        message: input.message,
        terminal: input.terminal,
        errorMessage: input.errorMessage,
      },
    };

    await this.publish(this.options.progressTopic, event);
  }

  private async publish<T>(
    topic: string,
    event: IIntegrationEvent<T>,
  ): Promise<void> {
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= KafkaEventPublisher.MAX_RETRIES;
      attempt += 1
    ) {
      try {
        await lastValueFrom(this.kafkaClient.emit(topic, event));
        return;
      } catch (error: unknown) {
        lastError = error;
      }
    }

    throw lastError;
  }
}

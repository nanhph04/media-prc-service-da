import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ConfigModule } from '../../shared/infrastructure/config/config.module';
import { ConfigService } from '../../shared/infrastructure/config/config.service';
import {
  getKafkaBrokers,
  getKafkaEventPublisherOptions,
  getMinioStorageOptions,
  KAFKA_EVENT_PUBLISHER_OPTIONS,
  MINIO_STORAGE_OPTIONS,
} from './infrastructure/config/media-processing.config';
import { KafkaEventPublisher } from './infrastructure/messaging/kafka-event-publisher';
import { MEDIA_EVENTS_CLIENT } from './infrastructure/messaging/media-events.constants';
import { VideoProcessor } from './infrastructure/processors/video.processor';
import { VideoProcessingFailureNotificationQueue } from './infrastructure/queue/video-processing-failure-notification.queue';
import { FfmpegTranscoderService } from './infrastructure/services/ffmpeg-transcoder.service';
import { MinioStorageService } from './infrastructure/storage/minio-storage.service';

@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      {
        name: MEDIA_EVENTS_CLIENT,
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: 'media-processing-service',
              brokers: getKafkaBrokers(configService),
            },
            producer: {
              createPartitioner: Partitioners.LegacyPartitioner,
            },
            producerOnlyMode: true,
          },
        }),
      },
    ]),
  ],
  providers: [
    {
      provide: KAFKA_EVENT_PUBLISHER_OPTIONS,
      useFactory: getKafkaEventPublisherOptions,
      inject: [ConfigService],
    },
    {
      provide: MINIO_STORAGE_OPTIONS,
      useFactory: getMinioStorageOptions,
      inject: [ConfigService],
    },
    FfmpegTranscoderService,
    KafkaEventPublisher,
    MinioStorageService,
    VideoProcessingFailureNotificationQueue,
    VideoProcessor,
  ],
  exports: [VideoProcessor],
})
export class MediaProcessingModule {}

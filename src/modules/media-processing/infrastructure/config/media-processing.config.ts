import { ConfigService } from '../../../../shared/infrastructure/config/config.service';

export interface KafkaEventPublisherOptions {
  successTopic: string;
  failedTopic: string;
  thumbnailGeneratedTopic: string;
  thumbnailFailedTopic: string;
}

export interface MinioStorageOptions {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  rawBucket: string;
  processedBucket: string;
  publicBucket: string;
  publicEndpoint?: string;
  publicPort?: number;
  publicUseSSL?: boolean;
  tempRootDirectory: string;
}

export interface RedisQueueOptions {
  queueName: string;
  connection: {
    host: string;
    port: number;
    password?: string;
    db: number;
  };
}

export const KAFKA_EVENT_PUBLISHER_OPTIONS = 'KAFKA_EVENT_PUBLISHER_OPTIONS';
export const MINIO_STORAGE_OPTIONS = 'MINIO_STORAGE_OPTIONS';
export const TRANSCODE_JOB_NAME = 'transcode-job';
export const DEFAULT_VIDEO_PROCESSING_QUEUE_NAME = 'video-processing';

export const getKafkaBrokers = (configService: ConfigService): string[] =>
  configService
    .get<string>(
      'KAFKA_BROKERS',
      configService.get<string>('KAFKA_BROKER', 'localhost:9092'),
    )
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

export const getKafkaEventPublisherOptions = (
  configService: ConfigService,
): KafkaEventPublisherOptions => ({
  successTopic: configService.get<string>(
    'KAFKA_VIDEO_PROCESSED_SUCCESS_TOPIC',
    'video.processed.success',
  ),
  failedTopic: configService.get<string>(
    'KAFKA_VIDEO_PROCESSED_FAILED_TOPIC',
    'video.processed.failed',
  ),
  thumbnailGeneratedTopic: configService.get<string>(
    'KAFKA_VIDEO_THUMBNAIL_GENERATED_TOPIC',
    'video.thumbnail.generated',
  ),
  thumbnailFailedTopic: configService.get<string>(
    'KAFKA_VIDEO_THUMBNAIL_FAILED_TOPIC',
    'video.thumbnail.failed',
  ),
});

export const getMinioStorageOptions = (
  configService: ConfigService,
): MinioStorageOptions => {
  const publicPort = configService.get<string | number>(
    'MINIO_PUBLIC_PORT',
    '',
  );
  const publicUseSSL = configService.get<string | boolean>(
    'MINIO_PUBLIC_USE_SSL',
    '',
  );

  return {
    endPoint: configService.get<string>('MINIO_ENDPOINT', 'localhost'),
    port: configService.get<number>('MINIO_PORT', 9000),
    useSSL: configService.get<boolean>('MINIO_USE_SSL', false),
    accessKey: configService.get<string>('MINIO_ACCESS_KEY', 'admin'),
    secretKey: configService.get<string>('MINIO_SECRET_KEY', 'admin123'),
    rawBucket: configService.get<string>('MINIO_RAW_BUCKET', 'media-raw'),
    processedBucket: configService.get<string>(
      'MINIO_PROCESSED_BUCKET',
      'media-processed',
    ),
    publicBucket: configService.get<string>(
      'MINIO_PUBLIC_BUCKET',
      'media-public',
    ),
    publicEndpoint: configService.get<string>('MINIO_PUBLIC_ENDPOINT', ''),
    publicPort:
      publicPort === '' || publicPort === undefined
        ? undefined
        : Number(publicPort),
    publicUseSSL:
      publicUseSSL === '' || publicUseSSL === undefined
        ? undefined
        : publicUseSSL === true || publicUseSSL === 'true',
    tempRootDirectory: configService.get<string>(
      'MEDIA_PROCESSING_TMP_DIR',
      '/tmp/media-processing',
    ),
  };
};

export const getRedisQueueOptions = (
  configService: ConfigService,
): RedisQueueOptions => {
  const password = configService.get<string>('REDIS_PASSWORD', '');

  return {
    queueName: configService.get<string>(
      'BULLMQ_QUEUE_NAME',
      DEFAULT_VIDEO_PROCESSING_QUEUE_NAME,
    ),
    connection: {
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: password.length > 0 ? password : undefined,
      db: configService.get<number>('REDIS_DB', 0),
    },
  };
};

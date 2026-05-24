import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import {
  DEFAULT_VIDEO_PROCESSING_QUEUE_NAME,
  getKafkaBrokers,
  getMinioStorageOptions,
  getRedisQueueOptions,
  TRANSCODE_JOB_NAME,
} from './media-processing.config';

describe('media-processing config', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses media_service-compatible MinIO bucket defaults', () => {
    delete process.env.MINIO_RAW_BUCKET;
    delete process.env.MINIO_PROCESSED_BUCKET;
    delete process.env.MINIO_PUBLIC_BUCKET;
    const options = getMinioStorageOptions(new ConfigService());

    expect(options.rawBucket).toBe('media-raw');
    expect(options.processedBucket).toBe('media-processed');
    expect(options.publicBucket).toBe('media-public');
  });

  it('uses media_service-compatible BullMQ defaults and job name', () => {
    delete process.env.BULLMQ_QUEUE_NAME;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_DB;
    const options = getRedisQueueOptions(new ConfigService());

    expect(TRANSCODE_JOB_NAME).toBe('transcode-job');
    expect(DEFAULT_VIDEO_PROCESSING_QUEUE_NAME).toBe('video-processing');
    expect(options).toEqual({
      queueName: 'video-processing',
      connection: {
        host: 'localhost',
        port: 6379,
        password: undefined,
        db: 0,
      },
    });
  });

  it('reads Redis password and db from environment', () => {
    process.env.BULLMQ_QUEUE_NAME = 'custom-video-processing';
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_DB = '2';
    const options = getRedisQueueOptions(new ConfigService());

    expect(options).toEqual({
      queueName: 'custom-video-processing',
      connection: {
        host: 'redis',
        port: 6380,
        password: 'secret',
        db: 2,
      },
    });
  });

  it('supports KAFKA_BROKERS with KAFKA_BROKER fallback', () => {
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_BROKER = 'localhost:9092';
    expect(getKafkaBrokers(new ConfigService())).toEqual(['localhost:9092']);

    process.env.KAFKA_BROKERS = 'kafka-1:9092, kafka-2:9092';
    expect(getKafkaBrokers(new ConfigService())).toEqual([
      'kafka-1:9092',
      'kafka-2:9092',
    ]);
  });
});

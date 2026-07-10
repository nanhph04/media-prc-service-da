import { Queue, Worker, type Job } from 'bullmq';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import type { KafkaEventPublisher } from '../messaging/kafka-event-publisher';
import { VideoProcessingFailureNotificationQueue } from './video-processing-failure-notification.queue';

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
}));

describe('VideoProcessingFailureNotificationQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMocks = (): {
    configService: jest.Mocked<ConfigService>;
    eventPublisher: jest.Mocked<KafkaEventPublisher>;
  } => ({
    configService: {
      getMaxVideoDurationSeconds: jest.fn().mockReturnValue(4 * 60 * 60),
      get: jest
        .fn()
        .mockImplementation(
          (_key: string, defaultValue: string | number | boolean) =>
            defaultValue,
        ),
    } as unknown as jest.Mocked<ConfigService>,
    eventPublisher: {
      publishVideoProcessedFailed: jest.fn().mockResolvedValue(undefined),
      publishVideoProcessedSuccess: jest.fn().mockResolvedValue(undefined),
      publishVideoThumbnailGenerated: jest.fn().mockResolvedValue(undefined),
      publishVideoThumbnailFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<KafkaEventPublisher>,
  });

  const getQueueAdd = (): jest.Mock => {
    const queueInstance = (Queue as unknown as jest.Mock).mock.results[0]
      .value as { add: jest.Mock };
    return queueInstance.add;
  };

  const getWorkerProcessor = (): ((job: Job) => Promise<void>) =>
    (Worker as unknown as jest.Mock).mock.calls[0][1] as (
      job: Job,
    ) => Promise<void>;

  it('creates the queue and worker with retry-capable Redis connection', () => {
    const { configService, eventPublisher } = createMocks();

    new VideoProcessingFailureNotificationQueue(configService, eventPublisher);

    expect(Queue).toHaveBeenCalledWith('video-processing-failure-notifications', {
      connection: {
        host: 'localhost',
        port: 6379,
        password: undefined,
        db: 0,
      },
    });
    expect(Worker).toHaveBeenCalledWith(
      'video-processing-failure-notifications',
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });

  it('enqueues a retained retryable processed-failed notification job', async () => {
    const { configService, eventPublisher } = createMocks();
    const queue = new VideoProcessingFailureNotificationQueue(
      configService,
      eventPublisher,
    );

    await queue.enqueueFinalFailure({
      videoId: 'video-123',
      traceId: 'trace-123',
      errorMessage: 'ffmpeg failed',
      shouldPublishThumbnailFailed: false,
    });

    expect(getQueueAdd()).toHaveBeenCalledWith(
      'publish-video-processed-failed',
      {
        videoId: 'video-123',
        traceId: 'trace-123',
        errorMessage: 'ffmpeg failed',
      },
      expect.objectContaining({
        jobId: 'processed-failed-video-123',
        attempts: 10,
        removeOnFail: 1000,
      }),
    );
  });

  it('enqueues thumbnail failure independently when thumbnail was requested', async () => {
    const { configService, eventPublisher } = createMocks();
    const queue = new VideoProcessingFailureNotificationQueue(
      configService,
      eventPublisher,
    );

    await queue.enqueueFinalFailure({
      videoId: 'video-123',
      traceId: 'trace-123',
      errorMessage: 'ffmpeg failed',
      shouldPublishThumbnailFailed: true,
    });

    expect(getQueueAdd()).toHaveBeenCalledWith(
      'publish-video-thumbnail-failed',
      {
        videoId: 'video-123',
        traceId: 'trace-123',
        errorMessage: 'ffmpeg failed',
      },
      expect.objectContaining({
        jobId: 'thumbnail-failed-video-123',
        attempts: 10,
        removeOnFail: 1000,
      }),
    );
  });

  it('publishes processed failed events from the notification worker', async () => {
    const { configService, eventPublisher } = createMocks();
    new VideoProcessingFailureNotificationQueue(configService, eventPublisher);

    await getWorkerProcessor()({
      name: 'publish-video-processed-failed',
      data: {
        videoId: 'video-123',
        traceId: 'trace-123',
        errorMessage: 'ffmpeg failed',
      },
    } as Job);

    expect(eventPublisher.publishVideoProcessedFailed).toHaveBeenCalledWith({
      videoId: 'video-123',
      traceId: 'trace-123',
      errorMessage: 'ffmpeg failed',
    });
  });

  it('publishes thumbnail failed events from the notification worker', async () => {
    const { configService, eventPublisher } = createMocks();
    new VideoProcessingFailureNotificationQueue(configService, eventPublisher);

    await getWorkerProcessor()({
      name: 'publish-video-thumbnail-failed',
      data: {
        videoId: 'video-123',
        traceId: 'trace-123',
        errorMessage: 'ffmpeg failed',
      },
    } as Job);

    expect(eventPublisher.publishVideoThumbnailFailed).toHaveBeenCalledWith({
      videoId: 'video-123',
      traceId: 'trace-123',
      reasonCode: 'UNKNOWN',
      message: 'ffmpeg failed',
      retryable: false,
    });
  });
});

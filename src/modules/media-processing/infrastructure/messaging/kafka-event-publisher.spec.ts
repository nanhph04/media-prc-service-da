import { of, throwError } from 'rxjs';
import { KafkaEventPublisher } from './kafka-event-publisher';
import type { ClientKafka } from '@nestjs/microservices';

describe('KafkaEventPublisher', () => {
  const createKafkaClient = (): jest.Mocked<Pick<ClientKafka, 'emit'>> => ({
    emit: jest.fn().mockReturnValue(of(undefined)),
  });

  it('publishes success event to configured topic using integration envelope', async () => {
    const kafkaClient = createKafkaClient();
    const publisher = new KafkaEventPublisher(
      kafkaClient as unknown as ClientKafka,
      {
        successTopic: 'video.processed.success',
        failedTopic: 'video.processed.failed',
      },
    );

    await publisher.publishVideoProcessedSuccess({
      videoId: 'video-123',
      traceId: 'trace-123',
      masterPlaylistKey: 'processed/video-123/master.m3u8',
      durationSeconds: 42,
      resolution: ['720p'],
    });

    expect(kafkaClient.emit).toHaveBeenCalledWith(
      'video.processed.success',
      expect.objectContaining({
        eventType: 'video.processed.success',
        aggregateId: 'video-123',
        traceId: 'trace-123',
        sourceService: 'media-processing-service',
        data: {
          videoId: 'video-123',
          masterPlaylistKey: 'processed/video-123/master.m3u8',
          durationSeconds: 42,
          resolution: ['720p'],
        },
      }),
    );
  });

  it('retries publish failures before succeeding', async () => {
    const kafkaClient = createKafkaClient();
    kafkaClient.emit
      .mockReturnValueOnce(throwError(() => new Error('kafka down')))
      .mockReturnValueOnce(of(undefined));
    const publisher = new KafkaEventPublisher(
      kafkaClient as unknown as ClientKafka,
      {
        successTopic: 'video.processed.success',
        failedTopic: 'video.processed.failed',
      },
    );

    await publisher.publishVideoProcessedFailed({
      videoId: 'video-123',
      traceId: 'trace-123',
      errorMessage: 'ffmpeg failed',
    });

    expect(kafkaClient.emit).toHaveBeenCalledTimes(2);
    expect(kafkaClient.emit).toHaveBeenLastCalledWith(
      'video.processed.failed',
      expect.objectContaining({
        eventType: 'video.processed.failed',
        data: {
          videoId: 'video-123',
          errorMessage: 'ffmpeg failed',
        },
      }),
    );
  });

});

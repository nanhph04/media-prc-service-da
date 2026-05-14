import type { Job } from 'bullmq';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import type { VideoProcessingJobData } from '../../application/dtos/video-processing-job-data.dto';
import { TRANSCODE_JOB_NAME } from '../config/media-processing.config';
import type { KafkaEventPublisher } from '../messaging/kafka-event-publisher';
import { VideoProcessor } from './video.processor';
import type { FfmpegTranscoderService } from '../services/ffmpeg-transcoder.service';
import type { MinioStorageService } from '../storage/minio-storage.service';

describe('VideoProcessor', () => {
  const createJob = (
    resolution: string[] = ['720p'],
  ): Job<VideoProcessingJobData> =>
    ({
      name: TRANSCODE_JOB_NAME,
      data: {
        videoId: 'video-123',
        rawFileKey: 'uploads/raw/channel-123/video.mp4',
        resolution,
        userId: 'user-123',
        traceId: 'trace-123',
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
      updateProgress: jest.fn().mockResolvedValue(undefined),
    }) as unknown as Job<VideoProcessingJobData>;

  const createMocks = (): {
    storageService: jest.Mocked<MinioStorageService>;
    transcoderService: jest.Mocked<FfmpegTranscoderService>;
    eventPublisher: jest.Mocked<KafkaEventPublisher>;
    configService: jest.Mocked<ConfigService>;
  } => ({
    storageService: {
      downloadRawVideo: jest.fn().mockResolvedValue('/tmp/video-123/input.mp4'),
      uploadHlsOutput: jest.fn().mockResolvedValue({
        masterPlaylistKey: 'processed/video-123/master.m3u8',
        resolution: ['480p', '720p'],
      }),
      cleanupLocalDirectory: jest.fn().mockResolvedValue(undefined),
      createWorkPaths: jest.fn().mockReturnValue({
        workDirectory: '/tmp/video-123',
        inputPath: '/tmp/video-123/input.mp4',
        outputDirectory: '/tmp/video-123/hls',
        masterPlaylistPath: '/tmp/video-123/hls/master.m3u8',
      }),
    } as unknown as jest.Mocked<MinioStorageService>,
    transcoderService: {
      probeVideoMetadata: jest.fn().mockResolvedValue({
        durationSeconds: 42,
        sourceHeight: 720,
        hasAudioStream: true,
      }),
      transcodeToHlsVariants: jest.fn().mockResolvedValue({
        durationSeconds: 42,
        resolutions: ['480p', '720p'],
      }),
    } as unknown as jest.Mocked<FfmpegTranscoderService>,
    eventPublisher: {
      publishVideoProcessedFailed: jest.fn().mockResolvedValue(undefined),
      publishVideoProcessedSuccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<KafkaEventPublisher>,
    configService: {
      getMaxVideoDurationSeconds: jest.fn().mockReturnValue(4 * 60 * 60),
      get: jest
        .fn()
        .mockImplementation(
          (_key: string, defaultValue: string | number | boolean) =>
            defaultValue,
        ),
    } as unknown as jest.Mocked<ConfigService>,
  });

  it('downloads, probes, transcodes, uploads, publishes success, and cleans up', async () => {
    const job = createJob(['480p', '1080p']);
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await processor.handleVideoProcessing(job);

    expect(storageService.downloadRawVideo).toHaveBeenCalledWith(
      'uploads/raw/channel-123/video.mp4',
      '/tmp/video-123/input.mp4',
    );
    expect(transcoderService.probeVideoMetadata).toHaveBeenCalledWith(
      '/tmp/video-123/input.mp4',
    );
    expect(transcoderService.transcodeToHlsVariants).toHaveBeenCalledWith({
      inputPath: '/tmp/video-123/input.mp4',
      outputDirectory: '/tmp/video-123/hls',
      resolutions: ['480p', '720p'],
    });
    expect(storageService.uploadHlsOutput).toHaveBeenCalledWith(
      'video-123',
      '/tmp/video-123/hls',
      ['480p', '720p'],
    );
    expect(eventPublisher.publishVideoProcessedSuccess).toHaveBeenCalledWith({
      videoId: 'video-123',
      traceId: 'trace-123',
      masterPlaylistKey: 'processed/video-123/master.m3u8',
      durationSeconds: 42,
      resolution: ['480p', '720p'],
    });
    expect(eventPublisher.publishVideoProcessedFailed).not.toHaveBeenCalled();
    expect((job.updateProgress as jest.Mock).mock.calls.at(-1)).toEqual([100]);
    expect(storageService.cleanupLocalDirectory).toHaveBeenCalledWith(
      '/tmp/video-123',
    );
  });

  it('does not publish failed event from a transient handler failure', async () => {
    const job = createJob(['1080p']);
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    transcoderService.probeVideoMetadata.mockResolvedValue({
      durationSeconds: 14401,
      sourceHeight: 1080,
      hasAudioStream: true,
    });
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await expect(processor.handleVideoProcessing(job)).rejects.toThrow(
      'Video duration exceeds maximum limit of 4 hours',
    );

    expect(transcoderService.transcodeToHlsVariants).not.toHaveBeenCalled();
    expect(eventPublisher.publishVideoProcessedFailed).not.toHaveBeenCalled();
  });

  it('throws without publishing failed event before BullMQ exhausts retries', async () => {
    const job = createJob(['480p']);
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    transcoderService.probeVideoMetadata.mockResolvedValue({
      durationSeconds: 120,
      sourceHeight: 360,
      hasAudioStream: true,
    });
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await expect(processor.handleVideoProcessing(job)).rejects.toThrow(
      'Video source resolution is lower than minimum supported 480p',
    );

    expect(transcoderService.transcodeToHlsVariants).not.toHaveBeenCalled();
    expect(eventPublisher.publishVideoProcessedFailed).not.toHaveBeenCalled();
  });

  it('does not publish final failed event before the last attempt', async () => {
    const job = {
      ...createJob(['720p']),
      opts: { attempts: 3 },
      attemptsMade: 2,
    } as Job<VideoProcessingJobData>;
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await (
      processor as unknown as {
        publishFinalFailureIfNeeded: (
          job: Job<VideoProcessingJobData>,
          error: Error,
        ) => Promise<void>;
      }
    ).publishFinalFailureIfNeeded(job, new Error('ffmpeg failed'));

    expect(eventPublisher.publishVideoProcessedFailed).not.toHaveBeenCalled();
  });

  it('publishes final failed event after the third failed attempt', async () => {
    const job = {
      ...createJob(['720p']),
      opts: { attempts: 3 },
      attemptsMade: 3,
    } as Job<VideoProcessingJobData>;
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await (
      processor as unknown as {
        publishFinalFailureIfNeeded: (
          job: Job<VideoProcessingJobData>,
          error: Error,
        ) => Promise<void>;
      }
    ).publishFinalFailureIfNeeded(job, new Error('ffmpeg failed'));

    expect(eventPublisher.publishVideoProcessedFailed).toHaveBeenCalledWith({
      videoId: 'video-123',
      traceId: 'trace-123',
      errorMessage: 'Video processing failed after 3 attempts: ffmpeg failed',
    });
  });

  it('skips unsupported job names without side effects', async () => {
    const job = {
      ...createJob(),
      name: 'transcode-video',
    } as Job<VideoProcessingJobData>;
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await processor.handleVideoProcessing(job);

    expect(storageService.downloadRawVideo).not.toHaveBeenCalled();
    expect(transcoderService.probeVideoMetadata).not.toHaveBeenCalled();
    expect(transcoderService.transcodeToHlsVariants).not.toHaveBeenCalled();
    expect(eventPublisher.publishVideoProcessedSuccess).not.toHaveBeenCalled();
    expect(eventPublisher.publishVideoProcessedFailed).not.toHaveBeenCalled();
  });
});

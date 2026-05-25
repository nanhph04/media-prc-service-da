import type { Job } from 'bullmq';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import { VIDEO_PROCESSING_ERROR_MESSAGES } from '../../application/constants/video-processing-errors.constant';
import type { VideoProcessingJobData } from '../../application/dtos/video-processing-job-data.dto';
import { TRANSCODE_JOB_NAME } from '../config/media-processing.config';
import type { KafkaEventPublisher } from '../messaging/kafka-event-publisher';
import { VideoProcessor } from './video.processor';
import type { FfmpegTranscoderService } from '../services/ffmpeg-transcoder.service';
import type { MinioStorageService } from '../storage/minio-storage.service';

describe('VideoProcessor', () => {
  const createJob = (
    resolution: string[] = ['720p'],
    data: Partial<VideoProcessingJobData> = {},
  ): Job<VideoProcessingJobData> =>
    ({
      name: TRANSCODE_JOB_NAME,
      data: {
        videoId: 'video-123',
        rawFileKey: 'uploads/raw/channel-123/video.mp4',
        resolution,
        userId: 'user-123',
        traceId: 'trace-123',
        ...data,
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
        thumbnailPath: '/tmp/video-123/thumbnail.jpg',
      }),
      getDefaultThumbnailBucket: jest.fn().mockReturnValue('media-public'),
      uploadThumbnail: jest.fn().mockResolvedValue({
        objectKey: 'videos/video-123/thumbnails/default.jpg',
        url: 'http://localhost:9000/media-public/videos/video-123/thumbnails/default.jpg',
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
      generateThumbnail: jest.fn().mockResolvedValue({
        width: 1280,
        height: 720,
        capturedAtSecond: 4,
      }),
    } as unknown as jest.Mocked<FfmpegTranscoderService>,
    eventPublisher: {
      publishVideoProcessedFailed: jest.fn().mockResolvedValue(undefined),
      publishVideoProcessedSuccess: jest.fn().mockResolvedValue(undefined),
      publishVideoThumbnailGenerated: jest.fn().mockResolvedValue(undefined),
      publishVideoThumbnailFailed: jest.fn().mockResolvedValue(undefined),
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

  it('uploads generated thumbnails to the target bucket from the job payload', async () => {
    const job = createJob(['720p'], {
      thumbnailTargetObjectKey: 'videos/video-123/thumbnails/default.jpg',
      thumbnailTargetBucket: 'media-public',
    });
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await processor.handleVideoProcessing(job);

    expect(transcoderService.generateThumbnail).toHaveBeenCalledWith({
      inputPath: '/tmp/video-123/input.mp4',
      outputPath: '/tmp/video-123/thumbnail.jpg',
      durationSeconds: 42,
    });
    expect(storageService.uploadThumbnail).toHaveBeenCalledWith(
      'media-public',
      'videos/video-123/thumbnails/default.jpg',
      '/tmp/video-123/thumbnail.jpg',
    );
    expect(storageService.getDefaultThumbnailBucket).not.toHaveBeenCalled();
    expect(eventPublisher.publishVideoThumbnailGenerated).toHaveBeenCalledWith({
      videoId: 'video-123',
      traceId: 'trace-123',
      thumbnailObjectKey: 'videos/video-123/thumbnails/default.jpg',
      thumbnailUrl:
        'http://localhost:9000/media-public/videos/video-123/thumbnails/default.jpg',
      width: 1280,
      height: 720,
      capturedAtSecond: 4,
    });
  });

  it('uses the configured public thumbnail bucket when old jobs omit target bucket', async () => {
    const job = createJob(['720p'], {
      thumbnailTargetObjectKey: 'videos/video-123/thumbnails/default.jpg',
    });
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await processor.handleVideoProcessing(job);

    expect(storageService.getDefaultThumbnailBucket).toHaveBeenCalled();
    expect(storageService.uploadThumbnail).toHaveBeenCalledWith(
      'media-public',
      'videos/video-123/thumbnails/default.jpg',
      '/tmp/video-123/thumbnail.jpg',
    );
    expect(eventPublisher.publishVideoThumbnailGenerated).toHaveBeenCalled();
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
      VIDEO_PROCESSING_ERROR_MESSAGES.DURATION_EXCEEDS_LIMIT,
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
      VIDEO_PROCESSING_ERROR_MESSAGES.SOURCE_RESOLUTION_BELOW_MINIMUM,
    );

    expect(transcoderService.transcodeToHlsVariants).not.toHaveBeenCalled();
    expect(eventPublisher.publishVideoProcessedFailed).not.toHaveBeenCalled();
  });

  it('throws a specific error when no requested resolutions are provided', async () => {
    const job = createJob([]);
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await expect(processor.handleVideoProcessing(job)).rejects.toThrow(
      VIDEO_PROCESSING_ERROR_MESSAGES.REQUESTED_RESOLUTIONS_REQUIRED,
    );

    expect(transcoderService.transcodeToHlsVariants).not.toHaveBeenCalled();
    expect(eventPublisher.publishVideoProcessedFailed).not.toHaveBeenCalled();
  });

  it('throws a specific error when requested resolutions are unsupported', async () => {
    const job = createJob(['144p']);
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await expect(processor.handleVideoProcessing(job)).rejects.toThrow(
      VIDEO_PROCESSING_ERROR_MESSAGES.REQUESTED_RESOLUTIONS_UNSUPPORTED,
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

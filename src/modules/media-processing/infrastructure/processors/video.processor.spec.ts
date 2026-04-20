import type { Job } from 'bullmq';
import { VideoProcessor } from './video.processor';
import type { VideoProcessingJobData } from '../../application/dtos/video-processing-job-data.dto';
import { ConfigService } from '../../../../shared/infrastructure/config/config.service';
import { TRANSCODE_JOB_NAME } from '../config/media-processing.config';
import type { FfmpegTranscoderService } from '../services/ffmpeg-transcoder.service';
import type { KafkaEventPublisher } from '../messaging/kafka-event-publisher';
import type { MinioStorageService } from '../storage/minio-storage.service';

describe('VideoProcessor', () => {
  const createJob = (): Job<VideoProcessingJobData> =>
    ({
      name: TRANSCODE_JOB_NAME,
      data: {
        videoId: 'video-123',
        rawFileKey: 'uploads/raw/channel-123/video.mp4',
        resolution: ['720p'],
        userId: 'user-123',
        traceId: 'trace-123',
      },
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
        resolution: ['720p'],
      }),
      cleanupLocalDirectory: jest.fn().mockResolvedValue(undefined),
      createWorkPaths: jest.fn().mockReturnValue({
        workDirectory: '/tmp/video-123',
        inputPath: '/tmp/video-123/input.mp4',
        outputDirectory: '/tmp/video-123/hls',
        masterPlaylistPath: '/tmp/video-123/hls/master.m3u8',
        variantPlaylistPath: '/tmp/video-123/hls/720p.m3u8',
        segmentPattern: '/tmp/video-123/hls/720p_%03d.ts',
      }),
    } as unknown as jest.Mocked<MinioStorageService>,
    transcoderService: {
      convertMp4ToHls720p: jest.fn().mockResolvedValue({ durationSeconds: 42 }),
    } as unknown as jest.Mocked<FfmpegTranscoderService>,
    eventPublisher: {
      publishVideoProcessedFailed: jest.fn().mockResolvedValue(undefined),
      publishVideoProcessedSuccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<KafkaEventPublisher>,
    configService: {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>,
  });

  it('downloads, transcodes, uploads, publishes success, and cleans up', async () => {
    const job = createJob();
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await processor.handleVideoProcessing(job);

    expect(storageService.downloadRawVideo.mock.calls[0]).toEqual([
      'uploads/raw/channel-123/video.mp4',
      '/tmp/video-123/input.mp4',
    ]);
    expect(transcoderService.convertMp4ToHls720p.mock.calls[0]?.[0]).toEqual({
      inputPath: '/tmp/video-123/input.mp4',
      masterPlaylistPath: '/tmp/video-123/hls/master.m3u8',
      variantPlaylistPath: '/tmp/video-123/hls/720p.m3u8',
      segmentPattern: '/tmp/video-123/hls/720p_%03d.ts',
    });
    expect(storageService.uploadHlsOutput.mock.calls[0]).toEqual([
      'video-123',
      '/tmp/video-123/hls',
    ]);
    expect(
      eventPublisher.publishVideoProcessedSuccess.mock.calls[0]?.[0],
    ).toEqual({
      videoId: 'video-123',
      traceId: 'trace-123',
      masterPlaylistKey: 'processed/video-123/master.m3u8',
      durationSeconds: 42,
      resolution: ['720p'],
    });
    expect(eventPublisher.publishVideoProcessedFailed.mock.calls).toHaveLength(
      0,
    );
    expect((job.updateProgress as jest.Mock).mock.calls.at(-1)).toEqual([100]);
    expect(storageService.cleanupLocalDirectory.mock.calls[0]).toEqual([
      '/tmp/video-123',
    ]);
  });

  it('publishes failed event, rethrows, and cleans up when processing fails', async () => {
    const job = createJob();
    const { storageService, transcoderService, eventPublisher, configService } =
      createMocks();
    transcoderService.convertMp4ToHls720p.mockRejectedValue(
      new Error('ffmpeg failed'),
    );
    const processor = new VideoProcessor(
      storageService,
      transcoderService,
      eventPublisher,
      configService,
    );

    await expect(processor.handleVideoProcessing(job)).rejects.toThrow(
      'ffmpeg failed',
    );

    expect(
      eventPublisher.publishVideoProcessedFailed.mock.calls[0]?.[0],
    ).toEqual({
      videoId: 'video-123',
      traceId: 'trace-123',
      errorMessage: 'ffmpeg failed',
    });
    expect(eventPublisher.publishVideoProcessedSuccess.mock.calls).toHaveLength(
      0,
    );
    expect(storageService.cleanupLocalDirectory.mock.calls[0]).toEqual([
      '/tmp/video-123',
    ]);
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

    expect(storageService.downloadRawVideo.mock.calls).toHaveLength(0);
    expect(transcoderService.convertMp4ToHls720p.mock.calls).toHaveLength(0);
    expect(eventPublisher.publishVideoProcessedSuccess.mock.calls).toHaveLength(
      0,
    );
    expect(eventPublisher.publishVideoProcessedFailed.mock.calls).toHaveLength(
      0,
    );
  });
});

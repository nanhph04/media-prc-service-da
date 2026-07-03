import ffmpeg from 'fluent-ffmpeg';
import { FfmpegTranscoderService } from './ffmpeg-transcoder.service';

const ffmpegRun = jest.fn();
const ffmpegOutput = jest.fn();
const ffmpegOutputOptions = jest.fn();
const ffmpegOn = jest.fn();
const writeFileMock = jest.fn().mockResolvedValue(undefined);
var ffprobeMock: jest.Mock;

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

jest.mock('fluent-ffmpeg', () => {
  const fluentFfmpeg = jest.fn(() => ({
    outputOptions: ffmpegOutputOptions,
    output: ffmpegOutput,
    on: ffmpegOn,
    run: ffmpegRun,
  }));

  fluentFfmpeg.setFfmpegPath = jest.fn();
  ffprobeMock = jest.fn();
  fluentFfmpeg.ffprobe = ffprobeMock;

  return fluentFfmpeg;
});

describe('FfmpegTranscoderService', () => {
  beforeEach(() => {
    ffmpegRun.mockReset();
    jest.mocked(ffmpeg.setFfmpegPath).mockReset();
    ffmpegOutput.mockReset();
    ffmpegOutputOptions.mockReset();
    ffmpegOn.mockReset();
    ffprobeMock.mockReset();
    writeFileMock.mockReset();
    writeFileMock.mockResolvedValue(undefined);
    ffmpegOutputOptions.mockReturnThis();
    ffmpegOutput.mockReturnThis();
    ffmpegOn.mockReturnThis();
  });

  it('probes metadata and transcodes requested variants', async () => {
    let ffprobeCallCount = 0;
    ffprobeMock.mockImplementation(
      (
        _inputPath: string,
        callback: (
          error: Error | undefined,
          data?: {
            format?: { duration?: number };
            streams?: Array<{ codec_type?: string; height?: number }>;
          },
        ) => void,
      ) => {
        ffprobeCallCount += 1;
        callback(undefined, {
          format: { duration: 42.2 },
          streams:
            ffprobeCallCount === 1
              ? [{ codec_type: 'video', height: 1080 }, { codec_type: 'audio' }]
              : [
                  { codec_type: 'video', height: 1080 },
                  { codec_type: 'audio' },
                ],
        });
      },
    );
    ffmpegOn.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'end') {
        setImmediate(handler);
      }
      return {
        outputOptions: ffmpegOutputOptions,
        output: ffmpegOutput,
        on: ffmpegOn,
        run: ffmpegRun,
      };
    });
    const service = new FfmpegTranscoderService({
      get: jest.fn().mockReturnValue(''),
    });

    const result = await service.transcodeToHlsVariants({
      inputPath: '/tmp/input.mp4',
      outputDirectory: '/tmp/hls',
      resolutions: ['480p', '1080p'],
    });

    expect(ffmpegOutput.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('480p.m3u8'),
    );
    expect(ffmpegOutput.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining('1080p.m3u8'),
    );
    expect(ffmpegOutputOptions.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        '-map 0:a:0',
        '-threads 2',
        '-hls_segment_filename',
        expect.stringContaining('480p_%03d.ts'),
      ]),
    );
    expect(ffmpegOutputOptions.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        '-map 0:a:0',
        '-threads 2',
        '-hls_segment_filename',
        expect.stringContaining('1080p_%03d.ts'),
      ]),
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining('master.m3u8'),
      expect.stringContaining('480p.m3u8'),
      'utf8',
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining('master.m3u8'),
      expect.stringContaining('1080p.m3u8'),
      'utf8',
    );
    expect(result).toEqual({
      durationSeconds: 42,
      resolutions: ['480p', '1080p'],
    });
  });

  it('builds HLS command without audio mapping when input has no audio stream', async () => {
    ffprobeMock.mockImplementation(
      (
        _inputPath: string,
        callback: (
          error: Error | undefined,
          data?: {
            format?: { duration?: number };
            streams?: Array<{ codec_type?: string; height?: number }>;
          },
        ) => void,
      ) => {
        callback(undefined, {
          format: { duration: 10 },
          streams: [{ codec_type: 'video', height: 720 }],
        });
      },
    );
    ffmpegOn.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'end') {
        setImmediate(handler);
      }
      return {
        outputOptions: ffmpegOutputOptions,
        output: ffmpegOutput,
        on: ffmpegOn,
        run: ffmpegRun,
      };
    });
    const service = new FfmpegTranscoderService({
      get: jest.fn().mockReturnValue(''),
    });

    await service.transcodeToHlsVariants({
      inputPath: '/tmp/input.mp4',
      outputDirectory: '/tmp/hls',
      resolutions: ['720p'],
    });

    const outputOptions = ffmpegOutputOptions.mock.calls[0]?.[0] as string[];

    expect(outputOptions).toContain('-an');
    expect(outputOptions).toContain('-threads 2');
    expect(outputOptions).not.toContain('-map 0:a:0');
  });

  it('reports throttled HLS progress with estimated segment counts', async () => {
    ffprobeMock.mockImplementation(
      (
        _inputPath: string,
        callback: (
          error: Error | undefined,
          data?: {
            format?: { duration?: number };
            streams?: Array<{ codec_type?: string; height?: number }>;
          },
        ) => void,
      ) => {
        callback(undefined, {
          format: { duration: 48 },
          streams: [
            { codec_type: 'video', height: 720 },
            { codec_type: 'audio' },
          ],
        });
      },
    );
    ffmpegOn.mockImplementation(
      (
        eventName: string,
        handler: (payload?: { percent?: number; timemark?: string }) => void,
      ) => {
        if (eventName === 'progress') {
          setImmediate(() => handler({ percent: 25, timemark: '00:00:12.00' }));
        }
        if (eventName === 'end') {
          setImmediate(() => handler());
        }
        return {
          outputOptions: ffmpegOutputOptions,
          output: ffmpegOutput,
          on: ffmpegOn,
          run: ffmpegRun,
        };
      },
    );
    const onProgress = jest.fn();
    const service = new FfmpegTranscoderService({
      get: jest.fn().mockReturnValue(''),
    });

    await service.transcodeToHlsVariants({
      inputPath: '/tmp/input.mp4',
      outputDirectory: '/tmp/hls',
      resolutions: ['720p'],
      videoId: 'video-123',
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith({
      resolution: '720p',
      progressPercent: 25,
      overallProgressPercent: 25,
      segmentIndex: 2,
      totalSegments: 8,
    });
    expect(onProgress).toHaveBeenCalledWith({
      resolution: '720p',
      progressPercent: 100,
      overallProgressPercent: 100,
      segmentIndex: 8,
      totalSegments: 8,
    });
  });

  it('uses configured HLS segment duration for ffmpeg options and segment estimates', async () => {
    ffprobeMock.mockImplementation(
      (
        _inputPath: string,
        callback: (
          error: Error | undefined,
          data?: {
            format?: { duration?: number };
            streams?: Array<{ codec_type?: string; height?: number }>;
          },
        ) => void,
      ) => {
        callback(undefined, {
          format: { duration: 48 },
          streams: [
            { codec_type: 'video', height: 720 },
            { codec_type: 'audio' },
          ],
        });
      },
    );
    ffmpegOn.mockImplementation(
      (
        eventName: string,
        handler: (payload?: { percent?: number; timemark?: string }) => void,
      ) => {
        if (eventName === 'progress') {
          setImmediate(() => handler({ percent: 25, timemark: '00:00:12.00' }));
        }
        if (eventName === 'end') {
          setImmediate(() => handler());
        }
        return {
          outputOptions: ffmpegOutputOptions,
          output: ffmpegOutput,
          on: ffmpegOn,
          run: ffmpegRun,
        };
      },
    );
    const onProgress = jest.fn();
    const service = new FfmpegTranscoderService({
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue: unknown) =>
          key === 'HLS_SEGMENT_DURATION_SECONDS' ? 12 : defaultValue,
        ),
    });

    await service.transcodeToHlsVariants({
      inputPath: '/tmp/input.mp4',
      outputDirectory: '/tmp/hls',
      resolutions: ['720p'],
      onProgress,
    });

    expect(ffmpegOutputOptions.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['-hls_time 12', '-threads 2']),
    );
    expect(onProgress).toHaveBeenCalledWith({
      resolution: '720p',
      progressPercent: 25,
      overallProgressPercent: 25,
      segmentIndex: 1,
      totalSegments: 4,
    });
  });

  it('rejects when ffmpeg emits error', async () => {
    ffprobeMock.mockImplementation(
      (
        _inputPath: string,
        callback: (
          error: Error | undefined,
          data?: {
            format?: { duration?: number };
            streams?: Array<{ codec_type?: string; height?: number }>;
          },
        ) => void,
      ) => {
        callback(undefined, {
          format: { duration: 10 },
          streams: [
            { codec_type: 'video', height: 720 },
            { codec_type: 'audio' },
          ],
        });
      },
    );
    ffmpegOn.mockImplementation(
      (eventName: string, handler: (error: Error) => void) => {
        if (eventName === 'error') {
          setImmediate(() => handler(new Error('ffmpeg failed')));
        }
        return {
          outputOptions: ffmpegOutputOptions,
          output: ffmpegOutput,
          on: ffmpegOn,
          run: ffmpegRun,
        };
      },
    );
    const service = new FfmpegTranscoderService({
      get: jest.fn().mockReturnValue(''),
    });

    await expect(
      service.transcodeToHlsVariants({
        inputPath: '/tmp/input.mp4',
        outputDirectory: '/tmp/hls',
        resolutions: ['720p'],
      }),
    ).rejects.toThrow('ffmpeg failed');
  });

  it('uses configured FFmpeg thread limit for transcode and thumbnail commands', async () => {
    ffprobeMock.mockImplementation(
      (
        _inputPath: string,
        callback: (
          error: Error | undefined,
          data?: {
            format?: { duration?: number };
            streams?: Array<{
              codec_type?: string;
              width?: number;
              height?: number;
            }>;
          },
        ) => void,
      ) => {
        callback(undefined, {
          format: { duration: 10 },
          streams: [
            { codec_type: 'video', width: 1280, height: 720 },
            { codec_type: 'audio' },
          ],
        });
      },
    );
    ffmpegOn.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'end') {
        setImmediate(handler);
      }
      return {
        outputOptions: ffmpegOutputOptions,
        output: ffmpegOutput,
        on: ffmpegOn,
        run: ffmpegRun,
      };
    });
    const service = new FfmpegTranscoderService({
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue: unknown) =>
          key === 'MEDIA_PROCESSING_FFMPEG_THREADS' ? 3 : defaultValue,
        ),
    });

    await service.transcodeToHlsVariants({
      inputPath: '/tmp/input.mp4',
      outputDirectory: '/tmp/hls',
      resolutions: ['720p'],
    });
    await service.generateThumbnail({
      inputPath: '/tmp/input.mp4',
      outputPath: '/tmp/thumbnail.jpg',
      durationSeconds: 10,
    });

    expect(ffmpegOutputOptions.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['-threads 3']),
    );
    expect(ffmpegOutputOptions.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(['-threads 3']),
    );
  });

  it('uses configured ffmpeg binary path when provided', () => {
    new FfmpegTranscoderService({
      get: jest.fn().mockReturnValue('C:\\ffmpeg\\bin\\ffmpeg.exe'),
    });

    expect(ffmpeg.setFfmpegPath).toHaveBeenCalledWith(
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
    );
  });
});

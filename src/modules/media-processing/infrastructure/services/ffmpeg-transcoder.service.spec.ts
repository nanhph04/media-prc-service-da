import { FfmpegTranscoderService } from './ffmpeg-transcoder.service';
import ffmpeg from 'fluent-ffmpeg';

const ffmpegRun = jest.fn();
const ffmpegOutput = jest.fn();
const ffmpegOutputOptions = jest.fn();
const ffmpegOn = jest.fn();
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('fluent-ffmpeg', () => {
  const fluentFfmpeg = jest.fn(() => ({
    outputOptions: ffmpegOutputOptions,
    output: ffmpegOutput,
    on: ffmpegOn,
    run: ffmpegRun,
  }));

  fluentFfmpeg.setFfmpegPath = jest.fn();

  return fluentFfmpeg;
});

describe('FfmpegTranscoderService', () => {
  beforeEach(() => {
    ffmpegRun.mockReset();
    jest.mocked(ffmpeg.setFfmpegPath).mockReset();
    ffmpegOutput.mockReset();
    ffmpegOutputOptions.mockReset();
    ffmpegOn.mockReset();
    ffmpegOutputOptions.mockReturnThis();
    ffmpegOutput.mockReturnThis();
    ffmpegOn.mockReturnThis();
  });

  it('builds 720p HLS ffmpeg command and resolves on end', async () => {
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

    await service.convertMp4ToHls720p({
      inputPath: '/tmp/input.mp4',
      masterPlaylistPath: '/tmp/hls/master.m3u8',
      variantPlaylistPath: '/tmp/hls/720p.m3u8',
      segmentPattern: '/tmp/hls/720p_%03d.ts',
    });

    expect(ffmpegOutputOptions).toHaveBeenCalledWith(
      expect.arrayContaining([
        '-s:v:0 1280x720',
        '-hls_segment_filename',
        '/tmp/hls/720p_%03d.ts',
        '-master_pl_name',
        'master.m3u8',
      ]),
    );
    expect(ffmpegOutput).toHaveBeenCalledWith('/tmp/hls/720p.m3u8');
    expect(ffmpegRun).toHaveBeenCalledTimes(1);
  });

  it('rejects when ffmpeg emits error', async () => {
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
      service.convertMp4ToHls720p({
        inputPath: '/tmp/input.mp4',
        masterPlaylistPath: '/tmp/hls/master.m3u8',
        variantPlaylistPath: '/tmp/hls/720p.m3u8',
        segmentPattern: '/tmp/hls/720p_%03d.ts',
      }),
    ).rejects.toThrow('ffmpeg failed');
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

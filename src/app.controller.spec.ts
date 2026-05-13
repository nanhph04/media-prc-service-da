import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller';

describe('AppController', () => {
  const appService = {
    getHello: jest.fn(),
  };
  const videoProcessor = {
    isReady: jest.fn(),
  };

  let controller: AppController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AppController(
      appService as never,
      videoProcessor as never,
    );
  });

  it('returns ready when the video processor worker exists', () => {
    videoProcessor.isReady.mockReturnValue(true);

    expect(controller.getReady()).toEqual({
      status: 'ok',
      worker: { ready: true },
    });
  });

  it('returns service unavailable when the video processor is not ready', () => {
    videoProcessor.isReady.mockReturnValue(false);

    expect(() => controller.getReady()).toThrow(ServiceUnavailableException);
  });
});

import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { VideoProcessor } from './modules/media-processing/infrastructure/processors/video.processor';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly videoProcessor: VideoProcessor,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health/ready')
  getReady(): { status: string; worker: { ready: boolean } } {
    const ready = this.videoProcessor.isReady();
    if (!ready) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        worker: { ready },
      });
    }

    return {
      status: 'ok',
      worker: { ready },
    };
  }
}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './shared/infrastructure/config/config.module';
import { MediaProcessingModule } from './modules/media-processing/media-processing.module';

@Module({
  imports: [ConfigModule, MediaProcessingModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

import { NestFactory } from '@nestjs/core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { ConfigService } from './shared/infrastructure/config/config.service';

function loadEnvironmentFile(): void {
  const environmentFilePath = join(process.cwd(), '.env');

  if (existsSync(environmentFilePath)) {
    process.loadEnvFile(environmentFilePath);
  }
}

async function bootstrap(): Promise<void> {
  loadEnvironmentFile();

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  await app.listen(configService.get<number>('PORT', 4003));
}
void bootstrap();

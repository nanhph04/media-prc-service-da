import { Inject, Injectable, Optional } from '@nestjs/common';
import { Client } from 'minio';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { TranscodeResolutionName } from '../services/ffmpeg-transcoder.service';
import {
  MINIO_STORAGE_OPTIONS,
  type MinioStorageOptions,
} from '../config/media-processing.config';

export interface VideoProcessingWorkPaths {
  workDirectory: string;
  inputPath: string;
  outputDirectory: string;
  masterPlaylistPath: string;
  thumbnailPath: string;
}

export interface UploadedHlsOutput {
  masterPlaylistKey: string;
  resolution: TranscodeResolutionName[];
}

@Injectable()
export class MinioStorageService {
  private readonly minioClient: Client;

  private readonly options: MinioStorageOptions;

  constructor(
    @Optional()
    @Inject(MINIO_STORAGE_OPTIONS)
    options?: MinioStorageOptions,
  ) {
    this.options = options ?? {
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'admin',
      secretKey: 'admin123',
      rawBucket: 'media-raw',
      processedBucket: 'media-processed',
      tempRootDirectory: '/tmp/media-processing',
    };
    this.minioClient = new Client({
      endPoint: this.options.endPoint,
      port: this.options.port,
      useSSL: this.options.useSSL,
      accessKey: this.options.accessKey,
      secretKey: this.options.secretKey,
    });
  }

  createWorkPaths(videoId: string): VideoProcessingWorkPaths {
    const workDirectory = join(this.options.tempRootDirectory, videoId);
    const outputDirectory = join(workDirectory, 'hls');

    return {
      workDirectory,
      inputPath: join(workDirectory, 'input.mp4'),
      outputDirectory,
      masterPlaylistPath: join(outputDirectory, 'master.m3u8'),
      thumbnailPath: join(workDirectory, 'thumbnail.jpg'),
    };
  }

  async downloadRawVideo(
    fileKey: string,
    destinationPath: string,
  ): Promise<string> {
    await mkdir(dirname(destinationPath), { recursive: true });
    await this.minioClient.fGetObject(
      this.options.rawBucket,
      fileKey,
      destinationPath,
    );
    return destinationPath;
  }

  async uploadHlsOutput(
    videoId: string,
    outputDirectory: string,
    resolutions: TranscodeResolutionName[],
  ): Promise<UploadedHlsOutput> {
    const files = await this.listFiles(outputDirectory);

    for (const filePath of files) {
      const relativePath = relative(outputDirectory, filePath).replace(
        /\\/g,
        '/',
      );
      const objectKey = this.toProcessedObjectKey(videoId, relativePath);
      await this.minioClient.fPutObject(
        this.options.processedBucket,
        objectKey,
        filePath,
      );
    }

    return {
      masterPlaylistKey: `processed/${videoId}/master.m3u8`,
      resolution: resolutions,
    };
  }

  async uploadThumbnail(
    objectKey: string,
    thumbnailPath: string,
  ): Promise<{ objectKey: string; url: string }> {
    await this.minioClient.fPutObject(
      this.options.processedBucket,
      objectKey,
      thumbnailPath,
      {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    );

    return {
      objectKey,
      url: this.createProcessedObjectUrl(objectKey),
    };
  }

  async cleanupLocalDirectory(workDirectory: string): Promise<void> {
    await rm(workDirectory, { recursive: true, force: true });
  }

  private toProcessedObjectKey(videoId: string, relativePath: string): string {
    if (relativePath.endsWith('.ts')) {
      return `processed/${videoId}/segments/${basename(relativePath)}`;
    }

    return `processed/${videoId}/${relativePath}`;
  }

  private createProcessedObjectUrl(objectKey: string): string {
    const endpoint =
      this.options.publicEndpoint && this.options.publicEndpoint.length > 0
        ? this.options.publicEndpoint
        : this.options.endPoint;
    const port = this.options.publicPort ?? this.options.port;
    const useSSL = this.options.publicUseSSL ?? this.options.useSSL;
    const url = new URL(`${useSSL ? 'https' : 'http'}://${endpoint}`);
    url.port = String(port);
    url.pathname = `${this.options.processedBucket}/${objectKey}`
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');

    return url.toString();
  }

  private async listFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listFiles(fullPath)));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  }
}

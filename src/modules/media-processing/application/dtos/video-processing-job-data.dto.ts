export interface VideoProcessingJobData {
  videoId: string;
  rawFileKey: string;
  resolution: string[];
  userId: string;
  traceId?: string;
  thumbnailTargetObjectKey?: string;
  thumbnailTargetBucket?: string;
}

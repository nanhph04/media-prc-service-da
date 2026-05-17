export type VideoThumbnailFailureReason =
  | 'SOURCE_NOT_FOUND'
  | 'FFMPEG_FAILED'
  | 'STORAGE_UPLOAD_FAILED'
  | 'UNKNOWN';

export interface VideoThumbnailFailedEventData {
  videoId: string;
  reasonCode: VideoThumbnailFailureReason;
  message: string;
  retryable: boolean;
}

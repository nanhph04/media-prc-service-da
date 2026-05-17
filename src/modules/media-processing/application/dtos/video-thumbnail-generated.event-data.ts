export interface VideoThumbnailGeneratedEventData {
  videoId: string;
  thumbnailObjectKey: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  capturedAtSecond: number;
}

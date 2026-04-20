export interface VideoProcessedSuccessEventData {
  videoId: string;
  masterPlaylistKey: string;
  durationSeconds?: number;
  thumbnailUrl?: string | null;
  resolution?: string[];
}

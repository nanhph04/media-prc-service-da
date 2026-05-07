export interface VideoProgressUpdatedEventData {
  videoId: string;
  pipeline: 'processing';
  stage:
    | 'queued'
    | 'downloading'
    | 'probing'
    | 'transcoding'
    | 'uploading'
    | 'finalizing'
    | 'completed'
    | 'failed';
  percent: number;
  message: string;
  terminal: boolean;
  errorMessage?: string;
}

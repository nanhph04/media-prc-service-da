# Media Processing Service Events

All integration events use the shared envelope:

```ts
interface IIntegrationEvent<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  timestamp: string;
  version: number;
  traceId: string;
  spanId?: string;
  sourceService: string;
  data: T;
}
```

## video.processed.success

Published after HLS transcoding succeeds.

Topic:

```text
video.processed.success
```

Data:

```json
{
  "videoId": "video-id",
  "masterPlaylistKey": "processed/video-id/master.m3u8",
  "durationSeconds": 120,
  "thumbnailUrl": null,
  "resolution": ["480p", "720p"]
}
```

## video.processed.failed

Published after the transcode job exhausts attempts.

Topic:

```text
video.processed.failed
```

Data:

```json
{
  "videoId": "video-id",
  "errorMessage": "Video processing failed after 3 attempts: ..."
}
```

## video.thumbnail.generated

Published when an auto thumbnail is generated and uploaded to MinIO.

Topic:

```text
video.thumbnail.generated
```

Data:

```json
{
  "videoId": "video-id",
  "thumbnailObjectKey": "videos/video-id/thumbnails/default.jpg",
  "thumbnailUrl": "http://localhost:9000/media-processed/videos/video-id/thumbnails/default.jpg",
  "width": 1280,
  "height": 720,
  "capturedAtSecond": 12
}
```

## video.thumbnail.failed

Published when auto thumbnail generation fails after retry.

Topic:

```text
video.thumbnail.failed
```

Data:

```json
{
  "videoId": "video-id",
  "reasonCode": "FFMPEG_FAILED",
  "message": "ffmpeg exited with code 1",
  "retryable": false
}
```

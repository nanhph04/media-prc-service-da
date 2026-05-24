# Media Processing Service Flows

## Transcode with auto thumbnail

```mermaid
sequenceDiagram
    autonumber
    participant Media as Media Service
    participant Queue as BullMQ
    participant Processor as Media Processing Service
    participant Storage as MinIO Storage
    participant Kafka

    Media->>Queue: Add transcode-job
    Queue-->>Processor: videoId, rawFileKey, resolutions, thumbnailTargetBucket, thumbnailTargetObjectKey
    Processor->>Storage: Download raw video from bucket raw
    Processor->>Processor: Probe metadata with FFmpeg
    opt thumbnailTargetObjectKey present
        Processor->>Processor: Generate JPEG thumbnail at ~10% duration, fallback second 1
        Processor->>Storage: Upload thumbnail to requested target bucket
        Processor->>Kafka: Publish video.thumbnail.generated
    end
    Processor->>Processor: Transcode HLS variants
    Processor->>Storage: Upload HLS output to bucket processed
    Processor->>Kafka: Publish video.processed.success
```

## Failure behavior

- The BullMQ transcode job still owns final video processing retries.
- Thumbnail generation is retried up to 3 times inside the job.
- If thumbnail generation fails, the service publishes `video.thumbnail.failed` and continues with video transcoding.
- If the transcode job fails after BullMQ attempts, the service publishes `video.processed.failed`.
- If a failed transcode job included a thumbnail target key, a final `video.thumbnail.failed` can also be published so Media Service can move thumbnail status to `failed`.

## Storage paths

- Raw input: supplied by Media Service, usually `uploads/confirmed/{videoId}/{uuid}.mp4` in bucket `raw`.
- HLS output: `processed/{videoId}/master.m3u8` and `processed/{videoId}/segments/*.ts` in bucket `processed`.
- Auto thumbnail: `videos/{videoId}/thumbnails/default.jpg` in the `thumbnailTargetBucket` supplied by Media Service, normally bucket `public`.

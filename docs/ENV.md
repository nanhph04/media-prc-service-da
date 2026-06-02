# Media Processing Service ENV

## Kafka

```text
KAFKA_BROKER=localhost:9092
KAFKA_BROKERS=localhost:9092
KAFKA_VIDEO_PROCESSED_SUCCESS_TOPIC=video.processed.success
KAFKA_VIDEO_PROCESSED_FAILED_TOPIC=video.processed.failed
KAFKA_VIDEO_THUMBNAIL_GENERATED_TOPIC=video.thumbnail.generated
KAFKA_VIDEO_THUMBNAIL_FAILED_TOPIC=video.thumbnail.failed
```

## MinIO

```text
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=admin
MINIO_SECRET_KEY=admin123
MINIO_RAW_BUCKET=media-raw
MINIO_PROCESSED_BUCKET=media-processed
MINIO_PUBLIC_ENDPOINT=
MINIO_PUBLIC_PORT=
MINIO_PUBLIC_USE_SSL=
```

- Raw video is read from `MINIO_RAW_BUCKET`.
- HLS output and generated thumbnails are written to `MINIO_PROCESSED_BUCKET`.
- `MINIO_PUBLIC_*` is used to build public thumbnail URLs in `video.thumbnail.generated`.

## FFmpeg

```text
FFMPEG_PATH=
VIDEO_MAX_DURATION_SECONDS=14400
MEDIA_PROCESSING_TMP_DIR=/tmp/media-processing
MEDIA_PROCESSING_CONCURRENCY=1
```

- Auto thumbnail output is JPEG.
- Default target key is supplied by Media Service: `videos/{videoId}/thumbnails/default.jpg`.
- `MEDIA_PROCESSING_CONCURRENCY` controls how many BullMQ video jobs one service process can run at the same time. Values below `1` are treated as `1`; higher values run more FFmpeg jobs concurrently and should be sized for available CPU, memory, and disk I/O.

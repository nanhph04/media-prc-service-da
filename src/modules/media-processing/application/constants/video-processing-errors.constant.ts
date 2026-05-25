export const VIDEO_PROCESSING_ERROR_MESSAGES = {
  SOURCE_RESOLUTION_BELOW_MINIMUM:
    'Video source resolution is lower than minimum supported 480p',
  REQUESTED_RESOLUTIONS_REQUIRED:
    'At least one requested video resolution must be provided',
  REQUESTED_RESOLUTIONS_UNSUPPORTED:
    'Requested video resolutions are not supported',
  DURATION_EXCEEDS_LIMIT: 'Video duration exceeds maximum limit of 4 hours',
  UNKNOWN_PROCESSING_ERROR: 'Unknown video processing error',
  UNKNOWN_THUMBNAIL_ERROR: 'Unknown thumbnail error',
} as const;

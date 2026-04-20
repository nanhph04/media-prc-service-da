export interface IIntegrationEvent<T = unknown> {
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

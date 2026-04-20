# AGENTS.md - Microservice User Service

## 1. Purpose

This document defines rules for the user_service in the microservice system.

Goals:

- Consistent architecture across services
- Easy onboarding for new developers
- Scalable and maintainable codebase

---

## 2. Commands

### Build & Start

```bash
npm run build          # Compile TypeScript to JavaScript
npm run start          # Run production build
npm run start:dev      # Run in development with watch mode
```

### Linting & Formatting

```bash
npm run lint           # Run ESLint with auto-fix
npm run format         # Format code with Prettier
```

---

## 3. Architecture Principles

All services MUST follow:

- Clean Architecture
- Pragmatic Clean Architecture (DDD-lite)
  - _Keep it simple for solo developers. Focus heavily on layer separation (Domain, App, Infra, Presentation)._
  - _Strict Value Objects and Aggregate Roots are strictly OPTIONAL and should be avoided unless explicitly requested to avoid boilerplate hell._
- SOLID principles
- Event-Driven Architecture (EDA)

### Layer Responsibilities

**domain/**

- Pure business logic
- No framework, no external libs (Pure TypeScript)
- Contains:
  - Entities & Aggregate Roots
  - Value Objects
  - Repository interfaces (ports)
  - Domain errors/exceptions

**application/**

- Orchestrates business logic
- Contains:
  - Use cases (Commands/Queries)
  - Application DTOs (input/output)
  - Interfaces for external services
- Rules:
  - MUST NOT depend on infrastructure or presentation
  - MAY depend on domain

**infrastructure/**

- Implementation details (Frameworks, DB, Message Brokers)
- Contains:
  - Database (ORM entities)
  - Repository implementations
  - External services (Redis, Kafka, HTTP clients)
  - Mappers (ORM <-> Domain)

**presentation/**

- Entry point (HTTP / gRPC / Kafka Consumers)
- Contains:
  - Controllers / Message Handlers
  - Guards / Interceptors / Filters
  - Transport DTOs (Swagger, request/response validation)
- Rules:
  - MUST ONLY call application layer (Use Cases)
  - MUST NOT access repositories or domain directly

---

## 4. Standard Folder Structure (NO `common` FOLDER)

```
src/
├── shared/                       # The ONLY place for shared code
│   ├── domain/
│   │   ├── value-objects/
│   │   ├── exceptions/
│   │   └── types/
│   ├── application/
│   │   ├── dtos/
│   │   └── interfaces/
│   ├── infrastructure/
│   │   ├── config/
│   │   ├── database/
│   │   ├── messaging/
│   │   └── utils/
│   └── presentation/
│       ├── filters/
│       ├── guards/
│       ├── decorators/
│       ├── interceptors/
│       └── dto/
│
└── modules/
    └── <module-name>/
        ├── domain/
        │   ├── entities/
        │   ├── repositories/
        │   └── events/
        ├── application/
        │   ├── use-cases/
        │   └── dtos/
        ├── infrastructure/
        │   ├── persistence/
        │   ├── messaging/
        │   └── mappers/
        └── presentation/
            ├── controllers/
            ├── consumers/
            └── dtos/
```

---

## 5. DTO Strategy

- Application DTO != Presentation DTO
- NEVER share DTO across layers

**Application DTO**: Input/output of use case, framework-independent

**Presentation DTO**: Request/response format, validation, Swagger decorators

---

## 6. Mapping Rules

| From          | To            | Layer          |
| ------------- | ------------- | -------------- |
| ORM Entity    | Domain Entity | infrastructure |
| Domain Entity | App DTO       | application    |
| App DTO       | Response DTO  | presentation   |

NEVER expose ORM entities outside infrastructure.

---

## 7. Use Case Rules

- One use case = one business action
- Use cases MUST be independent
- No side-effects outside defined ports
- Use case MUST be executed within a transaction boundary (if needed)
- Transaction handling MUST be implemented in infrastructure layer (UnitOfWork)

---

## 8. Repository Rules

- Define interface in domain layer
- Implement in infrastructure layer

---

## 9. Service Rules

Only 2 types of services allowed:

**application/services**: Domain services, external service interfaces (ports)

**infrastructure/services**: Redis, Kafka, External HTTP APIs (like Mailgun, Stripe, Nodemailer), Cloud Storage

---

## 10. Config Management

- **Config MUST be accessed only in infrastructure layer**
- Application layer receives config via dependency injection (interfaces)
- Define config interfaces in `application/interfaces/`
- Implement config loader in `infrastructure/config/`

---

## 11. Error Handling

Define specific errors in domain layer. Use Global Exception Filters to convert Domain Errors to HTTP status codes.

### Domain Exceptions

All domain exceptions are defined in `shared/domain/exceptions/domain.exception.ts`:

```ts
export class DomainException extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly errors?: string[],
  ) {
    super(message);
  }
}

// Common exceptions
export class NotFoundException extends DomainException {
  code: 'NOT_FOUND';
}
export class BadRequestException extends DomainException {
  code: 'BAD_REQUEST';
}
export class UnauthorizedException extends DomainException {
  code: 'UNAUTHORIZED';
}
export class ForbiddenException extends DomainException {
  code: 'FORBIDDEN';
}
export class ConflictException extends DomainException {
  code: 'CONFLICT';
}
export class InternalServerErrorException extends DomainException {
  code: 'INTERNAL_SERVER_ERROR';
}
```

### HttpExceptionFilter

Located at `shared/presentation/filters/http-exception.filter.ts`:

- Catches ALL exceptions (DomainException, HttpException, generic Error)
- Maps DomainException.code to HTTP status:
  - `NOT_FOUND` → 404
  - `BAD_REQUEST` → 400
  - `UNAUTHORIZED` → 401
  - `FORBIDDEN` → 403
  - `CONFLICT` → 409
  - `INTERNAL_SERVER_ERROR` → 500

### Response Format

Error responses use ApiError format (`shared/presentation/dto/api-response.dto.ts`):

```json
{
  "success": false,
  "code": 403,
  "mess": "You do not own this channel",
  "data": null,
  "errors": ["You do not own this channel"],
  "requestId": "1744712345-abc1234",
  "timestamp": "2026-04-15T10:19:05.123Z",
  "path": "/api/user/channels/123"
}
```

### Error Flow

```
Domain Layer (throw DomainException)
    ↓ bubbles up
Application Layer (no try/catch needed)
    ↓ bubbles up
Presentation Layer (HttpExceptionFilter catches)
    ↓ maps code → HTTP status
HTTP Response with ApiError format
```

### Logging

Errors are logged with:

- requestId for tracing
- Stack trace for debugging
- HTTP status, path, method

### Interceptors

**LoggerInterceptor** (`shared/presentation/interceptors/logger.interceptor.ts`):

- Generates unique `requestId` for each request (format: `timestamp-random`)
- Attaches requestId to request for end-to-end tracing
- Logs incoming request: method, url, ip, body (with sensitive data masked)
- Logs response: statusCode, duration
- Logs errors with stack trace
- Registered globally in `main.ts`

**Sensitive Data Masking**:

- `password` → `***`
- `refreshToken` → `***`

### Custom Decorators

Use decorators to extract Gateway headers in controllers:

**@CurrentUserId** (`shared/presentation/decorators/user-id.decorator.ts`):

- Extracts userId from header `x-user-id`
- Throws `UnauthorizedException` if header missing
- Usage: `@CurrentUserId() userId: string`

**@CurrentUserRole** (`shared/presentation/decorators/user-role.decorator.ts`):

- Extracts role from header `x-user-role`
- Returns `undefined` if header missing (use case handles validation)
- Usage: `@CurrentUserRole() role: string`

### Response DTOs

**ApiResponse** (`shared/presentation/dto/api-response.dto.ts`):

- Success response format
- `success: true`, `code: number`, `data: T`, optional `mess`, optional `pagination`

**ApiError** (`shared/presentation/dto/api-response.dto.ts`):

- Error response format
- `success: false`, `code: number` (HTTP status), `mess: string`, `errors: string[]`
- Auto-generated fields: `requestId`, `timestamp`, `path`

---

## 12. Event-Driven Integration

### Message Broker Payload Standard

ALL services MUST use a standardized envelope for events published to the Message Broker (Kafka/RabbitMQ/Redis). This ensures consistent parsing, distributed tracing, and idempotency across the entire system.

Define base event interface in `shared/domain/events/base-integration.event.ts`:

```ts
export interface IIntegrationEvent<T = unknown> {
  // --- METADATA ---
  eventId: string; // UUID v4 - Unique identifier for the event (For Idempotency)
  eventType: string; // e.g., 'video.uploaded', 'order.payment.success'
  aggregateId: string; // ID of the main entity involved (e.g., videoId, orderId)
  timestamp: string; // ISO 8601 Date String (UTC)
  version: number; // Schema version (Starts at 1)

  // --- OBSERVABILITY ---
  traceId: string; // Distributed Tracing ID (OpenTelemetry / Jaeger)
  spanId?: string; // Current Span ID (Optional but recommended)
  sourceService: string; // e.g., 'video-catalog-service'

  // --- BUSINESS DATA ---
  data: T; // The actual typed payload
}
```

Rules:

- Do NOT call other microservices directly unless synchronous response required
- Prefer async communication (Kafka/RabbitMQ)
- Domain Events (internal, sync)
- Integration Events (external, async via broker)
- **Consumers MUST implement idempotency using eventId** (e.g., storing processed event IDs in Redis/DB)
- Prefer async communication (Kafka/RabbitMQ)
- Domain Events (internal, sync)
- Integration Events (external, async via broker)
- Consumers MUST implement idempotency using eventId (e.g., storing processed event IDs in Redis/DB)

---

## 13. Cache (Redis)

- Only used in infrastructure layer
- Key format: `<service>:<entity>:<id>`

---

## 14. Logging

- Use centralized LoggerService
- Always include context (Trace ID, User ID)
- Log errors and important state changes

---

## 15. Naming Conventions

- Files: kebab-case suffix.ts
- Classes: PascalCase
- Interfaces: I\* prefix
- DTO: \*Dto
- Use cases: \*UseCase

---

## 16. Code Quality Rules

- strict mode enabled in tsconfig.json
- No any (Use unknown if necessary)
- Use import type for type-only imports
- Explicit return types for all methods and functions

---

## 17. Code Style Guidelines

### Imports

- Use `import type` for type-only imports
- Order: external libs, internal modules, relative paths
- STRICTLY AVOID barrel files (`index.ts`). Explicitly import from the direct file path to prevent circular dependencies and lower mental complexity.

### Formatting

- Run `npm run format` before committing
- Max line length: 100 characters
- Use 2 spaces for indentation

### Types

- Always declare explicit return types
- Use `unknown` instead of `any` when type is unknown
- Avoid `as` type assertions; use proper type guards

### Naming

- Variables: camelCase
- Constants: UPPER_SNAKE_CASE
- Enums: PascalCase with PascalCase members
- Boolean variables: prefix with `is`, `has`, `should`, `can`

### Error Handling

- Never swallow errors silently
- Always log errors with context
- Use domain-specific error classes
- Return appropriate HTTP status codes

---

## 18. Anti-Patterns (STRICTLY FORBIDDEN)

- Creating a src/common folder instead of src/shared
- Controller calling a repository directly
- Business logic inside a controller
- Using ORM @Entity outside infrastructure
- Sharing DTO between validation and Use Case input
- Application layer importing @nestjs/common or typeorm

---

## 19. Extensibility Guidelines

When adding new features:

1. Define domain first (Entities, Value Objects)
2. Define repository interfaces
3. Add Use Case
4. Implement infrastructure
5. Expose via presentation layer

---

## 20. Final Principle

Business logic must be independent of frameworks, databases, and message brokers.

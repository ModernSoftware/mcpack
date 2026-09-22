export type ErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_RESULT'
  | 'NOT_FOUND'
  | 'STARTUP_FAILED'
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_EXITED'
  | 'WORKER_PROTOCOL_ERROR'
  | 'QUEUE_FULL'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'RUNTIME_CLOSED'
  | 'HANDLER_FAILED';

/** Infrastructure errors are distinct from tool business results with isError=true. */
export class MCPackError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'MCPackError';
  }
}

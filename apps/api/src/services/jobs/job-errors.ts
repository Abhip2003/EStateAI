export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`Job "${id}" not found`);
    this.name = 'JobNotFoundError';
  }
}

export class JobNotCancellableError extends Error {
  constructor(id: string, status: string) {
    super(`Job "${id}" cannot be cancelled (status: ${status})`);
    this.name = 'JobNotCancellableError';
  }
}

export class JobNotRetryableError extends Error {
  constructor(id: string, status: string) {
    super(`Job "${id}" cannot be retried (status: ${status})`);
    this.name = 'JobNotRetryableError';
  }
}

// Base class for failures the executor must never retry — no amount of
// backoff fixes an unknown job type or a structurally invalid payload.
// Subclasses set FAILED (terminal) immediately instead of going through
// RetryService.
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export class UnsupportedJobTypeError extends PermanentJobError {
  constructor(type: string) {
    super(`No job handler registered for type "${type}"`);
    this.name = 'UnsupportedJobTypeError';
  }
}

export class InvalidJobPayloadError extends PermanentJobError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobPayloadError';
  }
}

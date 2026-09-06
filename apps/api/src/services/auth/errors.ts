export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`A user with email "${email}" already exists`);
    this.name = 'EmailAlreadyExistsError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

// Distinct from UnauthorizedError: the caller IS authenticated, but isn't
// allowed to act on this particular resource (e.g. not the asset's owner).
export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor(message = 'Invalid or expired refresh token') {
    super(message);
    this.name = 'InvalidRefreshTokenError';
  }
}

// Thrown when an already-revoked (previously rotated) refresh token is
// presented again — a signal the token was stolen. All other refresh tokens
// for the user are revoked as a response before this is thrown.
export class RefreshTokenReuseError extends InvalidRefreshTokenError {
  constructor() {
    super('Refresh token reuse detected');
    this.name = 'RefreshTokenReuseError';
  }
}

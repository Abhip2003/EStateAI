export class FindingNotFoundError extends Error {
  constructor(findingId: string) {
    super(`Finding not found: ${findingId}`);
    this.name = 'FindingNotFoundError';
  }
}

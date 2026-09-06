export class PolicyNotFoundError extends Error {
  constructor(id: string) {
    super(`Policy not found: ${id}`);
    this.name = 'PolicyNotFoundError';
  }
}

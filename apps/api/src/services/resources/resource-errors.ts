export class ResourceNotFoundError extends Error {
  constructor(id: string) {
    super(`Resource "${id}" not found`);
    this.name = 'ResourceNotFoundError';
  }
}

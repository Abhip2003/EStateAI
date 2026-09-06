export class UnsupportedRetrieverError extends Error {
  constructor(retrieverId: string) {
    super(`No retriever registered for "${retrieverId}"`);
    this.name = 'UnsupportedRetrieverError';
  }
}

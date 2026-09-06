export class AssetNotFoundError extends Error {
  constructor(id: string) {
    super(`Asset "${id}" not found`);
    this.name = 'AssetNotFoundError';
  }
}

export class CategoryNotFoundError extends Error {
  constructor(idOrSlug: string) {
    super(`Category "${idOrSlug}" not found`);
    this.name = 'CategoryNotFoundError';
  }
}

export class CategoryAlreadyExistsError extends Error {
  constructor(nameOrSlug: string) {
    super(`A category with name/slug "${nameOrSlug}" already exists`);
    this.name = 'CategoryAlreadyExistsError';
  }
}

export class TagNotFoundError extends Error {
  constructor(idOrName: string) {
    super(`Tag "${idOrName}" not found`);
    this.name = 'TagNotFoundError';
  }
}

export class TagAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`A tag with name "${name}" already exists`);
    this.name = 'TagAlreadyExistsError';
  }
}

export class AccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Account "${id}" not found`);
    this.name = 'AccountNotFoundError';
  }
}

export class AccountAlreadyExistsError extends Error {
  constructor(provider: string, externalId: string) {
    super(`An account for provider "${provider}" with external id "${externalId}" already exists`);
    this.name = 'AccountAlreadyExistsError';
  }
}

export class InvalidRiskScoreError extends Error {
  constructor(value: number) {
    super(`Risk score must be between 0 and 100 (received ${value})`);
    this.name = 'InvalidRiskScoreError';
  }
}

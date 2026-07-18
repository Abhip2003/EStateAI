import bcrypt from 'bcrypt';
import { config } from '../config/env.js';

class PasswordService {
  async hash(plainTextPassword: string): Promise<string> {
    return bcrypt.hash(plainTextPassword, config.security.bcryptCost);
  }

  async verify(plainTextPassword: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plainTextPassword, hash);
  }

  needsRehash(_hash: string): boolean {
    return false;
  }
}

export const passwordService = new PasswordService();

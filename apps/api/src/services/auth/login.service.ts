import { userRepository } from '../../repositories/user.repository.js';
import { passwordService } from '../password.service.js';
import { jwtService } from './jwt.service.js';
import { refreshTokenService } from './refresh-token.service.js';
import { InvalidCredentialsError } from './errors.js';
import { toSafeUser, type SafeUser } from './safe-user.js';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
}

class LoginService {
  async login(input: LoginInput): Promise<LoginResult> {
    const user = await userRepository.findByEmail(input.email);
    if (!user) {
      // Same error as an invalid password below — never reveal which part
      // of the credentials was wrong.
      throw new InvalidCredentialsError();
    }

    const isPasswordValid = await passwordService.verify(input.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new InvalidCredentialsError();
    }

    const accessToken = jwtService.signAccessToken(user);
    const { token: refreshToken } = await refreshTokenService.generate(user.id);

    return {
      user: toSafeUser(user),
      accessToken,
      refreshToken,
    };
  }
}

export const loginService = new LoginService();

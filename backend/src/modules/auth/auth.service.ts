import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { Snowflake } from '@/utils/snowflake';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { argon2id, hash, verify } from "argon2";
import { CookieOptions, Request, Response } from 'express';
import { EmailService } from 'src/email/email.service';
import { UAParser } from 'ua-parser-js';
import { UsersService } from '../users/users.service';
import { ChangePasswordDto, ForgotPasswordDto } from './dto/change-password.dto';
import { RegisterUser } from './dto/register-auth.dto';
import { TokenService } from './token.service';

const MAXINUM_AVAILABLE_TIME = 5 * 60_000
const MIN_TIME_TO_REQUEST = 60_000

@Injectable()
export class AuthService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService,
    private readonly tokenService: TokenService,
    // private readonly loginAttempService: LoginAttemptService,
    private readonly redisService: RedisService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) { }

  public async hashing(string: string): Promise<string> {
    return await hash(string,
      {
        type: argon2id,
        memoryCost: 2 ** 16,
        timeCost: 3,
        parallelism: 1,
        hashLength: 32
      }
    )
  }

  /**
   * Validates an access token and returns user information
   * @param accessToken - The JWT access token to validate
   * @throws UnauthorizedException - If token is invalid, expired, or user not found
   */
  async validate(accessToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync(accessToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });

      // Verify that the user exists in the database
      const user = await this.prismaService.user.findUnique({
        where: { id: payload.sub },
        include: { primaryEmail: true }
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Check if user has any active sessions (optional additional security)
      const activeSession = await this.prismaService.session.findFirst({
        where: {
          userId: user.id,
          revoked: false
        }
      });

      if (!activeSession) {
        throw new UnauthorizedException('User session is revoked');
      }

      return user
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  // get ip user
  private extractIp(req: Request): string {
    const xForwardedFor = req.headers['x-forwarded-for'] as string;
    return xForwardedFor?.split(',')[0] || req.socket.remoteAddress || '';
  }

  // get user agent
  private getDeviceName(userAgent: string): string {
    const parser = new UAParser(userAgent);
    const browser = parser.getBrowser().name || 'Unknown browser';
    const os = parser.getOS().name || 'Unknown OS';
    return `${browser} on ${os}`;
  }

  // async detectDevice(userId: string, ip: string, deviceName: string) {
  //   const lastSession = await this.prismaService.session.findFirst({
  //     where: { userId },
  //     orderBy: { createdAt: 'desc' },
  //   });

  //   if (!lastSession) return true;

  //   return lastSession.deviceName !== deviceName || lastSession.ipAddress !== ip;
  // }

  detectDevice(userId: string, ip: string, deviceName: string) {
    return this.prismaService.session.findFirst({
      where: { userId, deviceName, ipAddress: ip },
      orderBy: { createdAt: 'desc' },
    });
  }


  async registerUser(body: RegisterUser) {
    // const user = await this.prismaService.email.findFirst({ where: { value: body.email, NOT: { primaryEmailUser: null } } })
    const user = await this.usersService.findPrimaryUserByEmail(body.email)

    if (user) {
      throw new ConflictException("This email has been registered")
    }

    const hashedPassword = await this.hashing(body.password)
    const snowflake = new Snowflake()

    const newUser = await this.prismaService.user.create({
      data: {
        profileId: snowflake.generate(),
        displayName: body.displayName,
        birthday: body.birthday,
        gender: body.gender,
        primaryEmail: {
          create: {
            value: body.email
          }
        },
        hashedPassword: hashedPassword
      }
    })

    return {
      message: 'Register successful',
      data: newUser,
    }
  }

  async changePassword(data: ChangePasswordDto, req: Request) {
    const MAX_TIME_SAVE = 60 * 60 * 24 * 30 // 30 days

    if (!req.user?.id) {
      throw new UnauthorizedException('User ID is missing');
    }

    // const user = await this.prismaService.user.findFirst({
    const user = await this.prismaService.user.findUnique({
      where: { id: req.user?.id },
      omit: { hashedPassword: false }
    })

    // if (!user || typeof user.hashedPassword !== 'string') {
    //   throw new UnauthorizedException('User not found or password is missing');
    // }

    if (!user) {
      throw new NotFoundException("User not found")
    }

    const isMatch = await verify(user.hashedPassword, data.oldPassword);

    if (!isMatch) {
      throw new UnauthorizedException('Password is not matched');
    }

    // await this.redisService.set(req.user?.id, data.oldPassword, MAX_TIME_SAVE);
    await this.redisService.set(req.user.id, data.oldPassword, MAX_TIME_SAVE);

    const hashedNewPassword = await this.hashing(data.newPassword)

    const newUser = await this.prismaService.user.update({
      where: { id: req.user.id },
      data: { hashedPassword: hashedNewPassword },
      // include: { primaryEmail: true }
      include: { primaryEmail: { select: { value: true } } }
    })

    const { hashedPassword, ...userWithoutPassword } = newUser

    await this.emailService.sendNotificationResetPassword(newUser.primaryEmail.value)

    return {
      message: 'Change Password successful',
      data: userWithoutPassword
    }
  }

  async recoveryAccount(email: string) {
    // const exitingUser = await this.validate(email)
    const exitingUser = await this.usersService.findPrimaryUserByEmail(email)

    if (!exitingUser) {
      throw new NotFoundException('User is not found')
    }

    // Kiểm tra nếu exitingUser là array thì lấy user đầu tiên
    const user = Array.isArray(exitingUser) ? exitingUser[0] : exitingUser

    if (!user) {
      throw new NotFoundException('User is not found')
    }

    const token = this.tokenService.generateCode()

    // const updatedUser = await this.prismaService.user.update({
    //   where: { id: user.id },
    //   data: {
    //     status: "RECOVERY",
    //     createdAt: new Date()
    //   }
    // })

    // update code
    await this.prismaService.code.upsert({
      where: { id: { type: "RECOVERY", userId: user.id } },
      update: {
        tokens: [String(token)],
        expiresAt: new Date(Date.now() + MAXINUM_AVAILABLE_TIME)
      },
      create: {
        type: "RECOVERY",
        userId: user.id,
        tokens: [String(token)],
        expiresAt: new Date(Date.now() + MAXINUM_AVAILABLE_TIME)
      }
    })

    await this.emailService.sendResetPasswordAccount(email, String(token))

    return {
      message: 'Send recovery email successful'
    }
  }

  async confirmRecoveryAccount(email: string, code: string, newPassword: string) {
    const exitingUser = await this.prismaService.code.findFirst({
      where: { tokens: { has: code } }
    })

    if (exitingUser && exitingUser?.createdAt.getTime() + MIN_TIME_TO_REQUEST > Date.now()) {
      throw new ConflictException('Please wait 1 minutes before requesting again')
    }

    if (!exitingUser?.tokens.includes(code) || exitingUser.createdAt.getTime() + MAXINUM_AVAILABLE_TIME < Date.now()) {
      throw new UnauthorizedException('Code is not matched or expired')
    }

    await this.prismaService.user.update({
      where: { id: exitingUser.userId },
      data: {
        hashedPassword: await this.hashing(newPassword),
        code: { delete: { id: { type: "VERIFICATION", userId: exitingUser.userId } } }
      }
    })

    this.emailService.sendNotificationResetPassword(email)

    return {
      message: 'Send notification recovery email successful'
    }
  }

  async forgotPassword(email: string) {
    const user = await this.prismaService.user.findFirst({
      where: { primaryEmail: { value: email } }
    })

    if (!user) {
      throw new NotFoundException('Account is not exited')
    }

    const token = this.tokenService.generateCode()

    await this.prismaService.code.upsert({
      where: { id: { type: "VERIFICATION", userId: user.id } },
      update: {
        tokens: [String(token)],
        expiresAt: new Date(Date.now() + MAXINUM_AVAILABLE_TIME)
      },
      create: {
        type: "VERIFICATION",
        tokens: [String(token)],
        userId: user.id,
        expiresAt: new Date(Date.now() + MAXINUM_AVAILABLE_TIME)
      }
    })

    await this.emailService.sendResetPasswordAccount(email, String(token))

    return {
      message: 'Send req forgot successful'
    }
  }

  async verifyTokenForgotPassword(data: ForgotPasswordDto) {
    const code = await this.prismaService.code.findFirst({
      where: { userId: data.userId, type: "VERIFICATION" }
    })

    if (!code) {
      throw new NotFoundException('Code is not available or expired')
    }

    if (!code.tokens.includes(data.token)) {
      throw new ForbiddenException('Code does not matched')
    }

    await this.prismaService.user.update({
      where: { id: data.userId },
      data: {
        hashedPassword: await this.hashing(data.newPassword),
        code: { delete: { id: { type: "VERIFICATION", userId: data.userId } } }
      }
    })

    await this.emailService.sendNotificationResetPassword(data.email)

    return {
      message: 'Change password successful'
    }
  }

  async createSession(userId: string, res: Response, req: Request) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      include: {
        primaryEmail: true
      }
    })

    const ipAddress = this.extractIp(req) // ip user
    const userAgent = req.headers['user-agent'] || 'Unknown'// user agent
    const deviceName = this.getDeviceName(userAgent)

    const tokens = await this.tokenService.generateTokens(userId, String(user?.primaryEmail.value))

    const session = await this.tokenService.storeRefreshToken(userId, tokens.refreshToken, res.req.cookies?.session_id, { deviceName, ipAddress, userAgent })

    res.cookie('session_id', session.id, {
      maxAge: 10 * 365 * 24 * 60 * 60 * 1000 // 10 years
    })

    const cookieOptions: CookieOptions = {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    }

    res
      .cookie('refresh_token', tokens.refreshToken, {
        ...cookieOptions,
        maxAge: 60 * 60 * 1000, // 1h in milliseconds
      })
      .cookie('access_token', tokens.accessToken, {
        ...cookieOptions,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      })

    return { tokens, session }
  }

  async logout(res: Response, sessionId?: string) {
    res.clearCookie("access_token").clearCookie("refresh_token")

    const session = await this.prismaService.session.findFirst({
      where: { id: sessionId }
    })

    // Try to get sessionId from argument or cookies
    const sid = sessionId || res.req.cookies?.session_id;
    if (!sid) {
      throw new NotFoundException('Session ID is required for logout');
    }

    await this.prismaService.session.updateMany({
      where: { id: sid, userId: session?.userId },
      data: { refreshTokenHashed: null, revoked: true }
    });

    return {
      message: 'Logout successful'
    }
  }

  async login(data: any, res: Response, req: Request) {

    const user = await this.prismaService.user.findFirst({
      where: { primaryEmail: { value: data.email } },
      omit: { hashedPassword: false },
      include: { primaryEmail: true }
    })

    if (!user) { throw new NotFoundException('User not found') }

    // check bị suspended hay không thôi
    // const isLocked = await this.loginAttempService.isLocked(user.primaryEmail.value);
    // if (isLocked) {
    //   throw new ForbiddenException('Your account is temporary being locked. Please try later');
    // }

    const isMatch = await verify(user.hashedPassword, data.password)

    if (!isMatch) { throw new UnauthorizedException('Password is not matched') }

    const ip = this.extractIp(req) // ip user
    const userAgent = req.headers['user-agent'] || 'Unknown'// user agent
    const deviceName = this.getDeviceName(userAgent)

    const isNew = await this.detectDevice(user.id, ip, deviceName);

    // if detected new device , send email to user
    if (isNew) { await this.emailService.sendDetectOtherDevice(user.primaryEmail.value, ip, userAgent, deviceName) }

    const session = await this.createSession(user.id, res, req)

    const { hashedPassword, ...userWithoutPassword } = user

    return {
      message: 'Login successful',
      data: userWithoutPassword
    }
  }
}

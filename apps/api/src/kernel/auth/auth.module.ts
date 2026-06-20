import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

/**
 * Auth controller + service. The JWT/password services, Prisma, audit and
 * event bus are all provided by the global KernelModule.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}

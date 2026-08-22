import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { NumberCheckRateLimitGuard } from './number-check-rate-limit.guard';

@Module({
  controllers: [ContactController],
  providers: [ContactService, NumberCheckRateLimitGuard],
  exports: [ContactService],
})
export class ContactModule {}

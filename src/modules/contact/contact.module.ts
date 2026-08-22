import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { NumberCheckThrottlerGuard } from './number-check-throttler.guard';

@Module({
  controllers: [ContactController],
  providers: [ContactService, NumberCheckThrottlerGuard],
  exports: [ContactService],
})
export class ContactModule {}

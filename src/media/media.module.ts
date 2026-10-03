import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { ObjectStorageService } from './object-storage.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [MediaService, ObjectStorageService],
  exports: [ObjectStorageService],
})
export class MediaModule {}

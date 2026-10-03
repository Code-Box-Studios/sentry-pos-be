import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PortalAuthGuard } from '../auth/guards/portal-auth.guard';
import { MAX_IMAGE_BYTES } from './image';
import { MediaService } from './media.service';

const ImageUpload = () =>
  FileInterceptor('file', {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
  });
function bytes(file?: Express.Multer.File): Buffer {
  if (!file) throw new BadRequestException('Choose an image.');
  return file.buffer;
}
@Controller('portal')
@UseGuards(PortalAuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}
  @Get('businesses/:id/logo')
  logo(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.image('logo', id);
  }
  @Post('businesses/:id/logo')
  @UseInterceptors(ImageUpload())
  uploadLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.media.image('logo', id, bytes(file));
  }
  @Delete('businesses/:id/logo')
  deleteLogo(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.image('logo', id, undefined, true);
  }
  @Get('products/:id/image')
  product(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.image('product', id);
  }
  @Post('products/:id/image')
  @UseInterceptors(ImageUpload())
  uploadProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.media.image('product', id, bytes(file));
  }
  @Delete('products/:id/image')
  deleteProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.image('product', id, undefined, true);
  }
}

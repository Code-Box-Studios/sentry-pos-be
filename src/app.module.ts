import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { validate } from './config/env.validation';
import { ContextMiddleware } from './common/context/context.middleware';
import { AuthModule } from './auth/auth.module';
import { MailModule } from './mail/mail.module';
import { AdminModule } from './admin/admin.module';
import { PortalModule } from './portal/portal.module';
import { PosModule } from './pos/pos.module';
import { MediaModule } from './media/media.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LifecycleModule } from './portal/lifecycle/lifecycle.module';
import { StaffModule } from './staff/staff.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ManagerDataInterceptor } from './staff/manager-data.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    PrismaModule,
    MediaModule,
    NotificationsModule,
    LifecycleModule,
    MailModule,
    HealthModule,
    AuthModule,
    StaffModule,
    AdminModule,
    PortalModule,
    PosModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_INTERCEPTOR, useClass: ManagerDataInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}

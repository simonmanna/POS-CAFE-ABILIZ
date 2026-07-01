import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ id?: string; url?: string; method?: string }>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(body);
      return;
    }

    const detail = exception instanceof Error ? exception.message : String(exception);
    const name = exception instanceof Error ? exception.name : 'Error';
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url} [req: ${request.id ?? '-'}]: ${name}: ${detail}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    // Surface the actual cause to the client so the network tab shows something
    // useful instead of a bare "Internal Server Error" — this makes on-site
    // debugging possible. The short message + name are returned in every
    // environment; the full stack is dev-only (set NODE_ENV=production to hide).
    const isProd = process.env.NODE_ENV === 'production';
    response.status(500).json({
      message: 'Internal Server Error',
      statusCode: 500,
      requestId: request.id,
      error: detail,
      name,
      ...(isProd ? {} : { stack: exception instanceof Error ? exception.stack?.split('\n').slice(0, 12) : undefined }),
    });
  }
}

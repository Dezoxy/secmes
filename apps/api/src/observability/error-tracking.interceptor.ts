import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { type Observable, catchError, throwError } from 'rxjs';

import { isErrorTrackingEnabled } from './error-tracking.js';
import { routeLabel } from './metrics.js';

type RequestLike = Parameters<typeof routeLabel>[0] & {
  method?: string;
  auth?: { tenantId?: string; sub?: string };
};

/**
 * Reports server-side errors to Sentry/GlitchTip (#48) WITHOUT changing the response: it observes the error
 * in the RxJS stream and rethrows, so Nest's existing exception handling (and the typed ErrorResponse shape)
 * is unchanged. Captures only genuine server faults — 5xx HttpExceptions + anything non-HttpException
 * (unhandled); expected 4xx client errors are skipped. The event carries the HTTP method, the route-TEMPLATE
 * (never the populated URL/query/body — those are stripped by scrubEvent), and opaque tenant/user id tags. A
 * no-op when error tracking is disabled (no DSN).
 *
 * Deliberately an interceptor, not a global exception filter: it is non-invasive (rethrows; no response or WS
 * behaviour change). It sees errors from the handler pipeline; a guard that throws earlier is virtually always
 * a 4xx (not captured anyway), so the coverage gap is immaterial for Slice A.
 */
@Injectable()
export class ErrorTrackingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (isErrorTrackingEnabled() && context.getType() === 'http' && shouldCapture(err)) {
          const req = context.switchToHttp().getRequest<RequestLike>();
          Sentry.captureException(err, (scope) => {
            scope.setTag('http.method', req?.method ?? 'UNKNOWN');
            scope.setTag('http.route', routeLabel(req)); // route TEMPLATE — no IDs/query
            const auth = req?.auth;
            if (auth?.tenantId) scope.setTag('tenant', auth.tenantId); // opaque ids = metadata only
            if (auth?.sub) scope.setTag('user', auth.sub);
            return scope;
          });
        }
        return throwError(() => err); // rethrow — default handling unchanged
      }),
    );
  }
}

/** Capture only genuine server faults: 5xx HttpExceptions + anything non-HttpException (unhandled). */
export function shouldCapture(exception: unknown): boolean {
  if (exception instanceof HttpException) return exception.getStatus() >= 500;
  return true;
}

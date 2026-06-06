import { Controller, Get } from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from './auth/public.decorator.js';

const SERVICE = 'argus-api';
const VERSION = process.env.APP_VERSION ?? 'dev';

class HealthResponse {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

class ServiceInfoResponse {
  @ApiProperty()
  service!: string;

  @ApiProperty()
  version!: string;

  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

@ApiTags('system')
@Controller()
export class AppController {
  /** Liveness/readiness probe target. Must stay cheap and dependency-free. Public by design. */
  @Public()
  @Get('healthz')
  @ApiExcludeEndpoint() // operational probe, not part of the audited API contract
  @ApiOperation({ summary: 'Liveness/readiness probe', operationId: 'getHealth' })
  @ApiOkResponse({ type: HealthResponse })
  health(): HealthResponse {
    return { status: 'ok' };
  }

  @Public()
  @Get()
  @ApiExcludeEndpoint() // service banner, not part of the audited API contract
  @ApiOperation({ summary: 'Service identity + version', operationId: 'getServiceInfo' })
  @ApiOkResponse({ type: ServiceInfoResponse })
  root(): ServiceInfoResponse {
    return { service: SERVICE, version: VERSION, status: 'ok' };
  }
}

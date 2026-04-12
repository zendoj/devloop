import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

// Fas 0.1 security posture: bind exactly 127.0.0.1. The deployment contract is
// "Nginx on the same host proxies to 127.0.0.1:3100". ::1 is rejected because Nginx
// is configured for IPv4 loopback specifically. 'localhost' is rejected because it
// is resolver-dependent (/etc/hosts, systemd-resolved) and could bind ::1 on some
// systems. Later phases do not loosen this unless the deployment contract changes.
const REQUIRED_HOST = '127.0.0.1';
// 3100 is in use on this host by an unrelated CMS process; DevLoop
// uses 3110 to avoid the collision. Override via DEVLOOP_API_PORT.
const DEFAULT_PORT = 3110;

async function bootstrap(): Promise<void> {
  // Fail-closed sync guard. NODE_ENV must be EXPLICITLY 'development' to allow
  // synchronize=true. A missing or typo'd NODE_ENV is treated as non-development.
  const nodeEnvRaw = process.env['NODE_ENV'];
  const isDevelopment = nodeEnvRaw === 'development';
  const syncVarsSet: string[] = [];
  if (process.env['TYPEORM_SYNCHRONIZE'] === 'true') {
    syncVarsSet.push('TYPEORM_SYNCHRONIZE=true');
  }
  if (process.env['DB_SYNCHRONIZE'] === 'true') {
    syncVarsSet.push('DB_SYNCHRONIZE=true');
  }
  if (!isDevelopment && syncVarsSet.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[devloop-api] FATAL: synchronize=true detected outside explicit NODE_ENV=development (got NODE_ENV='${nodeEnvRaw ?? ''}'): ${syncVarsSet.join(', ')}. Refusing to start.`,
    );
    process.exit(1);
  }

  const host = process.env['DEVLOOP_API_HOST'] ?? REQUIRED_HOST;
  if (host !== REQUIRED_HOST) {
    // eslint-disable-next-line no-console
    console.error(
      `[devloop-api] FATAL: DEVLOOP_API_HOST='${host}' is not permitted. Fas 0.1 deployment contract requires exactly '${REQUIRED_HOST}'. Refusing to start.`,
    );
    process.exit(1);
  }

  // Strict port parsing: must be an integer string (no trailing junk).
  // parseInt('3100abc') would silently return 3100; we reject that here.
  const portRaw = process.env['DEVLOOP_API_PORT'];
  let port = DEFAULT_PORT;
  if (portRaw !== undefined) {
    if (!/^\d+$/.test(portRaw)) {
      // eslint-disable-next-line no-console
      console.error(
        `[devloop-api] FATAL: DEVLOOP_API_PORT='${portRaw}' is not a pure integer string. Refusing to start.`,
      );
      process.exit(1);
    }
    port = Number.parseInt(portRaw, 10);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    // eslint-disable-next-line no-console
    console.error(
      `[devloop-api] FATAL: DEVLOOP_API_PORT='${portRaw}' out of range. Refusing to start.`,
    );
    process.exit(1);
  }

  // Body limit is raised to ~520 MB (with a small headroom over
  // the 500 MB per-file cap the Files sidebar advertises) so the
  // operator can upload large reference files (screen recordings,
  // datasets, DB dumps) to the scratchpad under /var/lib/devloop/
  // files. JSON endpoints (reports, tasks, etc.) are still
  // implicitly capped by their own DTO length checks — this
  // bodyLimit only removes the global ceiling.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: false,
      bodyLimit: 520 * 1024 * 1024,
    }),
    {
      logger: ['log', 'warn', 'error'],
    },
  );

  // @fastify/cookie provides req.cookies parsing.
  await app.register(fastifyCookie as never);

  // @fastify/multipart handles the /api/files POST upload. We
  // use its helper methods from the controller (req.file()) to
  // stream bytes straight into /var/lib/devloop/files/ without
  // ever holding the full payload in memory. The 520 MB limit
  // matches bodyLimit above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fastifyMultipart = require('@fastify/multipart') as unknown;
  await app.register(fastifyMultipart as never, {
    limits: {
      fileSize: 520 * 1024 * 1024,
      files: 10,
      fields: 10,
    },
  });

  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`[devloop-api] listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[devloop-api] bootstrap failed:', err);
  process.exit(1);
});

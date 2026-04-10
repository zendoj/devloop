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

  // Fas 0.1 scaffolding: use Fastify's default bodyLimit. No upload/ingest
  // endpoints exist yet; widening the limit is deferred until a phase that
  // actually requires it (report intake in Fas 1).
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: false,
    }),
    {
      logger: ['log', 'warn', 'error'],
    },
  );

  // @fastify/cookie provides req.cookies parsing. No cookie signing key
  // is configured — the devloop_session cookie is an opaque random token
  // whose authenticity is proven by a DB lookup against its SHA-256
  // hash, not by HMAC signing.
  await app.register(fastifyCookie as never);

  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`[devloop-api] listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[devloop-api] bootstrap failed:', err);
  process.exit(1);
});

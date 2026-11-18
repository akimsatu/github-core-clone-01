// The entry's lifecycle: the wire between this forge and the suite that grades it.
//
// In a trial the env hands us MAKEFUN_ENV_URL, and the dance is fixed:
//   1. bind an ephemeral port (listen(0); never 8080, which the env owns),
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register — the env records the address
//      the request came from plus N and dials that as our base URL from then on,
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   4. close the server and exit 0.
//
// A register that answers 409 means another entry registered first; this process
// simply keeps waiting, like any other. Register and done requests that fail or
// time out are retried with exponential backoff, so a slowly starting env costs
// us nothing. The process never exits before the env says done: exiting early
// would leave no working forge and score 0.
//
// Without MAKEFUN_ENV_URL there is no env to talk to, so the forge runs standalone
// instead (a local mode for the kit's runner and for curl): it listens on
// $FORGE_PORT, or 18080, and serves until it is stopped. The trial path is
// untouched by that branch.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** One register or done request may take this long before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff between retries: first wait, then doubling, up to this ceiling. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or reports a first winner (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();

  // Local mode: no env, so serve standalone on a fixed port until stopped.
  if (ENV_URL === '') {
    const port = Number.parseInt(process.env.FORGE_PORT ?? '18080', 10) || 18080;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve());
    });
    process.stdout.write(`[entry] standalone mode: listening on port ${port}\n`);
    // Stay up until stopped: unlike the trial path, there is no env to say done.
    await new Promise<void>(() => {});
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

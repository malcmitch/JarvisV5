/**
 * Next.js Instrumentation — runs once when the server starts.
 *
 * We add a global uncaughtException handler specifically for ECONNRESET.
 * ECONNRESET happens when a client (phone/tablet) disconnects mid-request
 * (iOS tab kill, navigation, background throttle). Node.js normally lets this
 * bubble up as an uncaught exception which crashes and restarts the dev server,
 * causing a full page reload on every connected client.
 *
 * We swallow ECONNRESET because it is harmless — the request was already
 * abandoned by the client. All other uncaught exceptions are re-thrown.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    process.on('uncaughtException', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNRESET') {
        // Client disconnected mid-request — not a server error, ignore it.
        console.warn('[Jarvis Server] Swallowed ECONNRESET (client disconnected mid-request).');
        return;
      }
      // Re-throw anything that's a real crash.
      throw err;
    });

    process.on('unhandledRejection', (reason) => {
      const code = (reason as NodeJS.ErrnoException)?.code;
      if (code === 'ECONNRESET') {
        console.warn('[Jarvis Server] Swallowed unhandledRejection ECONNRESET.');
        return;
      }
      // Let real unhandled rejections surface normally.
      console.error('[Jarvis Server] Unhandled rejection:', reason);
    });
  }
}

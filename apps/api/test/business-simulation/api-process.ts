/**
 * Runs the real built API (dist/main.js) as a separate process against the
 * simulation database, so HTTP guards, the idempotency interceptor, the tenant
 * middleware and crash/restart behaviour are exercised exactly as deployed.
 */
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

const API_ROOT = path.resolve(__dirname, '../..');

export class ApiProcess {
  private child?: ChildProcess;
  readonly base: string;
  constructor(readonly port: number, readonly logFile: string, private readonly databaseUrl: string, private readonly mode: 'development' | 'production' = 'development') {
    this.base = `http://127.0.0.1:${port}/api/v1`;
  }

  async start(timeoutMs = 90_000) {
    if (!fs.existsSync(path.join(API_ROOT, 'dist/main.js'))) throw new Error('Build the API first: pnpm --filter @erp/api build');
    const fileEnv = dotenv.parse(fs.readFileSync(path.join(API_ROOT, '.env')));
    const log = fs.openSync(this.logFile, 'a');
    this.child = spawn(process.execPath, ['--max-http-header-size=65536', 'dist/main.js'], {
      cwd: API_ROOT,
      env: { ...process.env, ...fileEnv, DATABASE_URL: this.databaseUrl, PORT: String(this.port), NODE_ENV: this.mode, RLS_ALLOW_SUPERUSER: 'true', LOG_LEVEL: this.mode === 'production' ? 'warn' : 'info', METRICS_TOKEN: 'sim-metrics-token', BACKUP_CRON_ENABLED: 'false' },
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.child.exitCode != null) throw new Error(`API exited with ${this.child.exitCode}; see ${this.logFile}`);
      try {
        const r = await fetch(`${this.base}/health/ready`);
        if (r.ok) return;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('API did not become ready');
  }

  /** Hard kill (SIGKILL / TerminateProcess): no graceful shutdown hooks run. */
  async kill() {
    if (!this.child || this.child.exitCode != null) return;
    const exited = new Promise((r) => this.child!.once('exit', r));
    this.child.kill('SIGKILL');
    await exited;
  }

  async restart() {
    await this.kill();
    await this.start();
  }
}

export interface HttpResult { status: number; body: any }

export function client(base: string) {
  return async (method: string, url: string, opts: { token?: string; body?: unknown; key?: string; noKey?: boolean; headers?: Record<string, string> } = {}): Promise<HttpResult> => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        // Like the web client, every write carries an Idempotency-Key unless a test omits it on purpose.
        ...(opts.noKey || method === 'GET' || (url.startsWith('/auth/') && !opts.key) ? {} : { 'Idempotency-Key': opts.key ?? `sim-${Date.now()}-${Math.random().toString(36).slice(2)}` }),
        ...(opts.headers ?? {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, body };
  };
}

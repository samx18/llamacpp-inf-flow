// Dev-server bridge: POST /api/trace spawns the native tracer once and streams its stdout
// (newline-delimited trace events) to the response. No shell is involved; every argument is
// validated and passed as a separate argv entry.
//
// If the tracer exits non-zero, one final line {"bridge_error": "<stderr>"} is appended. That
// line is a transport message from this bridge, not a trace event.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Plugin } from 'vite';

const ROOT = path.resolve(__dirname, '..');
const TRACER = process.env.TRACER_BIN ?? path.join(ROOT, 'engine/build/bin/tracer');
const MODEL = process.env.TRACER_MODEL ?? path.join(ROOT, 'models/stories260K.gguf');

export interface TraceRequest {
  prompt: string;
  seed?: number;
  n_predict?: number;
  greedy?: boolean;
  top_k?: number;
  top_p?: number;
  temp?: number;
  force?: number[];
}

function isInt(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}
function isNum(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

export function tracerArgs(req: TraceRequest): string[] | string {
  if (typeof req.prompt !== 'string' || req.prompt.length === 0 || req.prompt.length > 4000) return 'prompt must be a non-empty string';
  const args = ['--model', MODEL, '--prompt', req.prompt];
  if (req.seed !== undefined) { if (!isInt(req.seed, 0, 0xfffffffe)) return 'bad seed'; args.push('--seed', String(req.seed)); }
  if (req.n_predict !== undefined) { if (!isInt(req.n_predict, 1, 512)) return 'bad n_predict'; args.push('--n-predict', String(req.n_predict)); }
  if (req.greedy) args.push('--greedy');
  if (req.top_k !== undefined) { if (!isInt(req.top_k, 0, 100000)) return 'bad top_k'; args.push('--top-k', String(req.top_k)); }
  if (req.top_p !== undefined) { if (!isNum(req.top_p, 0, 1)) return 'bad top_p'; args.push('--top-p', String(req.top_p)); }
  if (req.temp !== undefined) { if (!isNum(req.temp, 0, 10)) return 'bad temp'; args.push('--temp', String(req.temp)); }
  if (req.force !== undefined) {
    if (!Array.isArray(req.force) || req.force.length > 512 || !req.force.every((x) => isInt(x, 0, 10_000_000))) return 'bad force';
    if (req.force.length) args.push('--force', req.force.join(','));
  }
  return args;
}

export function tracerPlugin(): Plugin {
  return {
    name: 'llama-tracer-bridge',
    configureServer(server) {
      server.middlewares.use('/api/trace', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
        req.on('end', () => {
          let parsed: TraceRequest;
          try { parsed = JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }
          const args = tracerArgs(parsed);
          if (typeof args === 'string') { res.statusCode = 400; res.end(args); return; }
          if (!existsSync(TRACER)) { res.statusCode = 500; res.end(`tracer not built: ${TRACER}`); return; }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.setHeader('Cache-Control', 'no-store');
          const child = spawn(TRACER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = '';
          child.stdout.pipe(res, { end: false });
          child.stderr.on('data', (c) => { stderr += c; });
          res.on('close', () => { if (child.exitCode === null) child.kill(); });
          child.on('close', (code) => {
            if (code !== 0) res.write(JSON.stringify({ bridge_error: stderr.trim() || `tracer exited with ${code}` }) + '\n');
            res.end();
          });
        });
      });
    },
  };
}

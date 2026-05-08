#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startServer } from './server.js';

type Args = {
  repoPath?: string;
  port: number;
  ide?: string;
  host?: string;
};

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let repoPath: string | undefined;
  let port = 7777;
  let ide: string | undefined;
  let host: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      port = Number(args[++i]);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error('--port requires a positive number');
      }
    } else if (a === '--ide') {
      ide = args[++i];
    } else if (a === '--host') {
      host = args[++i];
      if (!host) throw new Error('--host requires a value');
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (!a.startsWith('--') && !repoPath) {
      repoPath = a;
    } else {
      throw new Error(`unrecognized argument: ${a}`);
    }
  }

  if (repoPath) {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`repo path does not exist: ${resolved}`);
    }
    if (!fs.existsSync(path.join(resolved, '.git'))) {
      throw new Error(`repo path is not a git repository: ${resolved}`);
    }
    repoPath = resolved;
  }

  return { repoPath, port, ide, host };
}

function printUsage() {
  process.stdout.write(
    'usage: sequoias [<repo-path>] [--port 7777] [--host 0.0.0.0] [--ide <command>]\n',
  );
}

function reachableUrls(port: number, host: string): string[] {
  const urls: string[] = [];
  if (host === '0.0.0.0' || host === '::') {
    urls.push(`http://localhost:${port}`);
    const interfaces = os.networkInterfaces();
    for (const list of Object.values(interfaces)) {
      if (!list) continue;
      for (const iface of list) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        urls.push(`http://${iface.address}:${port}`);
      }
    }
  } else {
    urls.push(`http://${host}:${port}`);
  }
  return urls;
}

async function main() {
  const args = parseArgs(process.argv);
  const server = await startServer(args);
  const host = server.host;
  const urls = reachableUrls(args.port, host);
  process.stdout.write(`sequoias listening (host=${host}):\n`);
  for (const u of urls) {
    process.stdout.write(`  ${u}\n`);
  }
  if (server.projectPaths.length > 0) {
    process.stdout.write(`projects: ${server.projectPaths.join(', ')}\n`);
  } else {
    process.stdout.write(
      'no projects configured yet — open the UI and add one, or restart with `sequoias <repo-path>`.\n',
    );
  }

  const shutdown = async (signal: string) => {
    process.stdout.write(`\nreceived ${signal}, shutting down...\n`);
    try {
      await server.close();
    } catch (err) {
      process.stderr.write(`shutdown error: ${(err as Error).message}\n`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});

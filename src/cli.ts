#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './server.js';

type Args = {
  repoPath: string;
  port: number;
  ide?: string;
};

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let repoPath: string | undefined;
  let port = 7777;
  let ide: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      port = Number(args[++i]);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error('--port requires a positive number');
      }
    } else if (a === '--ide') {
      ide = args[++i];
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (!a.startsWith('--') && !repoPath) {
      repoPath = a;
    } else {
      throw new Error(`unrecognized argument: ${a}`);
    }
  }

  if (!repoPath) {
    printUsage();
    throw new Error('repo path is required');
  }

  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`repo path does not exist: ${resolved}`);
  }
  if (!fs.existsSync(path.join(resolved, '.git'))) {
    throw new Error(`repo path is not a git repository: ${resolved}`);
  }
  return { repoPath: resolved, port, ide };
}

function printUsage() {
  process.stdout.write(
    'usage: sequoias <repo-path> [--port 7777] [--ide <command>]\n',
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const server = await startServer(args);
  process.stdout.write(
    `sequoias listening on http://localhost:${args.port} (project: ${args.repoPath})\n`,
  );

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

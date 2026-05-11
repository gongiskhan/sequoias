import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { simpleGit } from 'simple-git';
import { worktreeDir, slugify } from './paths.js';
import {
  discoverEnvFiles,
  ensureWorkspacePortFiles,
  readMainPortMap,
  rewriteEnvFiles,
} from './env-rewriter.js';
import { patchFrontendDevScripts } from './package-json-patcher.js';
import type { Session } from './types.js';

export type CreateWorktreeArgs = {
  repoPath: string;
  repoName: string;
  branch: string;
  baseBranch?: string;
};

export async function listLocalAndRemoteBranches(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  const local = await git.branchLocal();
  const remote = await git.branch(['-r']);
  const set = new Set<string>();
  for (const name of local.all) set.add(name);
  for (const name of remote.all) {
    if (name.endsWith('/HEAD')) continue;
    const stripped = name.replace(/^[^/]+\//, '');
    set.add(stripped);
  }
  return Array.from(set).sort();
}

export async function createWorktree(args: CreateWorktreeArgs): Promise<{
  worktreePath: string;
  envFiles: string[];
  ports: Record<string, number>;
}> {
  const { repoPath, repoName, branch, baseBranch } = args;
  const slug = slugify(branch);
  if (!slug) throw new Error('invalid branch name');
  const targetDir = worktreeDir(repoName, slug);

  if (fs.existsSync(targetDir)) {
    throw new Error(`worktree already exists at ${targetDir}`);
  }
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });

  const git = simpleGit(repoPath);
  const local = await git.branchLocal();
  const branchExists = local.all.includes(branch);

  if (branchExists) {
    await execa('git', ['worktree', 'add', targetDir, branch], { cwd: repoPath });
  } else {
    const base = baseBranch || (local.current ?? 'main');
    await execa('git', ['worktree', 'add', '-b', branch, targetDir, base], {
      cwd: repoPath,
    });
  }

  const mainEnvFiles = await discoverEnvFiles(repoPath);
  const mainPortMap = readMainPortMap(repoPath, mainEnvFiles);

  const worktreeEnvFiles: string[] = [];
  for (const rel of mainEnvFiles) {
    const src = path.join(repoPath, rel);
    const dst = path.join(targetDir, rel);
    if (!fs.existsSync(src)) continue;
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst)) {
      await fsp.copyFile(src, dst);
    }
    worktreeEnvFiles.push(rel);
  }

  const { ports } = await rewriteEnvFiles(targetDir, worktreeEnvFiles, {
    branch,
    mainPortMap,
  });

  const createdPortFiles = await ensureWorkspacePortFiles(targetDir, ports);
  for (const f of createdPortFiles) {
    if (!worktreeEnvFiles.includes(f)) worktreeEnvFiles.push(f);
  }

  // Patch frontend package.json dev scripts to fall back to
  // SEQUOIAS_FRONTEND_PORT when shell PORT is unset. Idempotent.
  await patchFrontendDevScripts(targetDir);

  await fsp.writeFile(
    path.join(targetDir, '.sequoias-meta.json'),
    JSON.stringify(
      {
        branch,
        repo: repoName,
        ports,
        envFiles: worktreeEnvFiles,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return { worktreePath: targetDir, envFiles: worktreeEnvFiles, ports };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: { deleteBranch?: boolean; branch?: string } = {},
): Promise<void> {
  if (fs.existsSync(worktreePath)) {
    try {
      await execa('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoPath,
      });
    } catch {
      // worktree may already be detached; ensure dir is gone
      await fsp.rm(worktreePath, { recursive: true, force: true });
      try {
        await execa('git', ['worktree', 'prune'], { cwd: repoPath });
      } catch {
        // ignore
      }
    }
  } else {
    try {
      await execa('git', ['worktree', 'prune'], { cwd: repoPath });
    } catch {
      // ignore
    }
  }

  if (options.deleteBranch && options.branch) {
    try {
      await execa('git', ['branch', '-D', options.branch], { cwd: repoPath });
    } catch {
      // ignore
    }
  }
}

export async function resyncEnvFiles(args: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  existingPorts: Record<string, number>;
  forceRecopy?: boolean;
}): Promise<{ envFiles: string[]; ports: Record<string, number>; copiedFiles: string[] }> {
  const { repoPath, worktreePath, branch, existingPorts, forceRecopy } = args;
  const mainEnvFiles = await discoverEnvFiles(repoPath);
  const mainPortMap = readMainPortMap(repoPath, mainEnvFiles);

  // Don't lock allocator to old (possibly invalid) ports — we want fresh,
  // valid allocations. Reserved is empty; the allocator's own deterministic
  // hash + linear-probe handles uniqueness.
  const reserved = new Set<number>();
  const copiedFiles: string[] = [];

  for (const rel of mainEnvFiles) {
    const src = path.join(repoPath, rel);
    const dst = path.join(worktreePath, rel);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dst) || forceRecopy) {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
      copiedFiles.push(rel);
    }
  }

  // Extend mainPortMap with the worktree's existing (possibly stale) port
  // values, so URLs already pointing to old worktree ports also get rewritten
  // to the new ones. Without this, healing an out-of-range port (e.g. 73512)
  // updates `.env`'s `API_PORT=` line but leaves `NEXT_PUBLIC_API_URL=...:73512`
  // unchanged.
  const extendedMap: typeof mainPortMap = { ...mainPortMap };
  for (const [service, port] of Object.entries(existingPorts)) {
    if (!extendedMap[port]) {
      extendedMap[port] = { service, key: `${service.toUpperCase()}_PORT` };
    }
  }

  const { ports } = await rewriteEnvFiles(worktreePath, mainEnvFiles, {
    branch,
    mainPortMap: extendedMap,
    reserved,
  });

  const createdPortFiles = await ensureWorkspacePortFiles(worktreePath, ports);
  for (const f of createdPortFiles) {
    if (!mainEnvFiles.includes(f)) mainEnvFiles.push(f);
  }

  // Patch frontend package.json dev scripts on every resync. Idempotent for
  // already-patched files; this is what brings 4-5-changes-old worktrees up
  // to date when the user clicks "Sync env".
  const patchedPkgs = await patchFrontendDevScripts(worktreePath);
  for (const f of patchedPkgs) {
    if (!copiedFiles.includes(f)) copiedFiles.push(f);
  }

  const mergedPorts = { ...existingPorts, ...ports };

  await fsp.writeFile(
    path.join(worktreePath, '.sequoias-meta.json'),
    JSON.stringify(
      {
        branch,
        ports: mergedPorts,
        envFiles: mainEnvFiles,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return { envFiles: mainEnvFiles, ports: mergedPorts, copiedFiles };
}

export function buildSession(args: {
  branch: string;
  worktreePath: string;
  ports: Record<string, number>;
  envFiles: string[];
}): Session {
  const now = new Date().toISOString();
  return {
    branch: args.branch,
    worktreePath: args.worktreePath,
    ports: args.ports,
    envFiles: args.envFiles,
    createdAt: now,
    lastStatus: 'starting',
    lastStatusAt: now,
  };
}

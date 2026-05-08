import os from 'node:os';
import path from 'node:path';

export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

export function sequoiasDir(): string {
  return path.join(homeDir(), '.sequoias');
}

export function statePath(): string {
  return path.join(sequoiasDir(), 'state.json');
}

export function settingsSnapshotPath(): string {
  return path.join(sequoiasDir(), 'settings-snapshot.bytes');
}

export function settingsSnapshotMetaPath(): string {
  return path.join(sequoiasDir(), 'settings-snapshot.meta.json');
}

export function claudeSettingsPath(): string {
  return path.join(homeDir(), '.claude', 'settings.json');
}

export function worktreesRoot(): string {
  return path.join(homeDir(), '.worktrees');
}

export function worktreeDir(repoName: string, branchSlug: string): string {
  return path.join(worktreesRoot(), repoName, branchSlug);
}

export function slugify(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

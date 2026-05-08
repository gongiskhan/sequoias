import { execa } from 'execa';
import { simpleGit } from 'simple-git';

export type CreatePrResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export async function createPullRequest(
  worktreePath: string,
  branch: string,
): Promise<CreatePrResult> {
  const git = simpleGit(worktreePath);

  try {
    const remote = await git.raw(['config', '--get', `branch.${branch}.remote`]).catch(() => '');
    const upstreamSet = remote.trim().length > 0;
    if (!upstreamSet) {
      await execa('git', ['push', '-u', 'origin', branch], { cwd: worktreePath });
    } else {
      await execa('git', ['push', 'origin', branch], { cwd: worktreePath });
    }
  } catch (err) {
    return {
      ok: false,
      error: `git push failed: ${(err as Error).message}`,
    };
  }

  try {
    const result = await execa('gh', ['pr', 'create', '--head', branch, '--fill'], {
      cwd: worktreePath,
      reject: false,
    });
    if (result.exitCode === 0) {
      const url = String(result.stdout).split(/\r?\n/).find((l) => l.startsWith('http'));
      if (url) return { ok: true, url: url.trim() };
      return { ok: true, url: String(result.stdout).trim() };
    }
    return {
      ok: false,
      error: String(result.stderr || result.stdout || 'gh pr create failed').trim(),
    };
  } catch (err) {
    return { ok: false, error: `gh pr create failed: ${(err as Error).message}` };
  }
}

export async function launchIde(ide: string, worktreePath: string): Promise<void> {
  await execa(ide, [worktreePath], { detached: true, stdio: 'ignore' }).catch((err) => {
    throw new Error(`failed to launch IDE '${ide}': ${(err as Error).message}`);
  });
}

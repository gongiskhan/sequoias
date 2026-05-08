import { execa } from 'execa';
import {
  SEQUOIAS_PORT_RANGE_START,
  SEQUOIAS_PORT_RANGE_END,
} from './ports.js';
import { killTree } from './pty-manager.js';

export type KillSwitchResult = {
  scannedRange: { start: number; end: number };
  pidsKilled: number[];
  ports: { port: number; pid: number; command: string }[];
};

const SIGKILL_DELAY_MS = 1000;

// Scan listening ports in the Sequoias range. Returns the ports + the PIDs
// holding them, without killing anything. Used both for the preview pass
// (UI shows the user what they're about to kill) and as the discovery step
// for killAllInSequoiasRange.
export async function listListenersInSequoiasRange(): Promise<KillSwitchResult> {
  const start = SEQUOIAS_PORT_RANGE_START;
  const end = SEQUOIAS_PORT_RANGE_END;
  const result: KillSwitchResult = {
    scannedRange: { start, end },
    pidsKilled: [],
    ports: [],
  };
  let stdout = '';
  try {
    const r = await execa(
      'lsof',
      ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Fpcn'],
      { reject: false, stdout: 'pipe', stderr: 'ignore' },
    );
    stdout = String(r.stdout || '');
  } catch {
    return result;
  }

  // lsof -F output: each record line begins with the field code:
  //   p<pid>
  //   c<command>
  //   n<host:port>
  // Records repeat per file descriptor, so we keep current pid/command and
  // pair each `n` line with them.
  let curPid: number | null = null;
  let curCmd = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      curPid = Number(line.slice(1));
      curCmd = '';
    } else if (line.startsWith('c')) {
      curCmd = line.slice(1);
    } else if (line.startsWith('n') && curPid !== null) {
      const m = line.slice(1).match(/:(\d+)$/);
      if (!m) continue;
      const port = Number(m[1]);
      if (port >= start && port <= end) {
        result.ports.push({ port, pid: curPid, command: curCmd });
      }
    }
  }
  return result;
}

// Scan all listening TCP ports, find ones in the Sequoias-managed range, and
// kill the entire process tree for each. Sequoias tracks worktree state, but
// orphan processes from forgotten/abandoned worktrees can pile up — this is
// the manual reset button.
export async function killAllInSequoiasRange(
  options: { onlyPids?: number[] } = {},
): Promise<KillSwitchResult> {
  const result = await listListenersInSequoiasRange();
  let pidsToKill = new Set(result.ports.map((p) => p.pid));
  if (options.onlyPids && options.onlyPids.length > 0) {
    const allow = new Set(options.onlyPids);
    pidsToKill = new Set([...pidsToKill].filter((p) => allow.has(p)));
  }
  if (pidsToKill.size === 0) return result;

  // SIGTERM all trees first.
  for (const pid of pidsToKill) {
    killTree(pid, 'SIGTERM');
  }
  await new Promise((r) => setTimeout(r, SIGKILL_DELAY_MS));
  // SIGKILL stragglers.
  for (const pid of pidsToKill) {
    killTree(pid, 'SIGKILL');
  }

  result.pidsKilled = Array.from(pidsToKill);
  return result;
}

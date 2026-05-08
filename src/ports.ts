import { execa } from 'execa';

export type ServiceRange = { name: string; start: number; end: number };

// One band for all services. Avoids fragmentation across worktrees + lets a
// single kill-switch sweep clear every Sequoias-managed process by port range.
export const SEQUOIAS_PORT_RANGE_START = 50000;
export const SEQUOIAS_PORT_RANGE_END = 54999;
const SEQUOIAS_PORT_RANGE_SIZE =
  SEQUOIAS_PORT_RANGE_END - SEQUOIAS_PORT_RANGE_START + 1;
const PROBE_LIMIT = 50;

// Kept exported for back-compat with any callers; allocation now uses the
// unified range regardless of named entries.
export const DEFAULT_RANGES: ServiceRange[] = [];

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function rangeFor(service: string, _ranges: ServiceRange[] = DEFAULT_RANGES): ServiceRange {
  return {
    name: service,
    start: SEQUOIAS_PORT_RANGE_START,
    end: SEQUOIAS_PORT_RANGE_END,
  };
}

export function basePort(branch: string, service: string, _ranges: ServiceRange[] = DEFAULT_RANGES): number {
  const offset = fnv1a32(`${branch}:${service}`) % SEQUOIAS_PORT_RANGE_SIZE;
  return SEQUOIAS_PORT_RANGE_START + offset;
}

export function isPortInSequoiasRange(port: number): boolean {
  return port >= SEQUOIAS_PORT_RANGE_START && port <= SEQUOIAS_PORT_RANGE_END;
}

export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const result = await execa('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-t'], {
      reject: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return Boolean(result.stdout && String(result.stdout).trim().length > 0);
  } catch {
    return false;
  }
}

export type AllocateOptions = {
  reserved?: Set<number>;
  isInUse?: (port: number) => Promise<boolean>;
  ranges?: ServiceRange[];
};

export async function allocatePort(
  branch: string,
  service: string,
  opts: AllocateOptions = {},
): Promise<number> {
  const reserved = opts.reserved ?? new Set<number>();
  const isInUse = opts.isInUse ?? isPortInUse;
  const r = rangeFor(service);
  const span = r.end - r.start + 1;
  let candidate = basePort(branch, service);
  for (let i = 0; i < PROBE_LIMIT; i++) {
    const probe = candidate + i;
    const wrapped = probe > r.end ? r.start + ((probe - r.start) % span) : probe;
    if (reserved.has(wrapped)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await isInUse(wrapped))) {
      reserved.add(wrapped);
      return wrapped;
    }
  }
  throw new Error(`no free port for ${branch}:${service} after ${PROBE_LIMIT} probes`);
}

export async function allocatePortMap(
  branch: string,
  services: string[],
  opts: AllocateOptions = {},
): Promise<Record<string, number>> {
  const reserved = opts.reserved ?? new Set<number>();
  const ports: Record<string, number> = {};
  for (const service of services) {
    // eslint-disable-next-line no-await-in-loop
    ports[service] = await allocatePort(branch, service, { ...opts, reserved });
  }
  return ports;
}

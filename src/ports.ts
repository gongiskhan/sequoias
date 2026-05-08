import { execa } from 'execa';

export type ServiceRange = { name: string; start: number; end: number };

export const DEFAULT_RANGES: ServiceRange[] = [
  { name: 'cortex', start: 4000, end: 4999 },
  { name: 'ekoa_app', start: 5000, end: 5999 },
];

const FALLBACK_BAND_START = 6000;
const FALLBACK_BAND_SIZE = 1000;
const PROBE_LIMIT = 50;

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function rangeFor(service: string, ranges: ServiceRange[] = DEFAULT_RANGES): ServiceRange {
  const known = ranges.find((r) => r.name === service);
  if (known) return known;
  const slot = fnv1a32(service) % 100;
  const start = FALLBACK_BAND_START + slot * FALLBACK_BAND_SIZE;
  return { name: service, start, end: start + FALLBACK_BAND_SIZE - 1 };
}

export function basePort(branch: string, service: string, ranges: ServiceRange[] = DEFAULT_RANGES): number {
  const r = rangeFor(service, ranges);
  const span = r.end - r.start + 1;
  const offset = fnv1a32(`${branch}:${service}`) % span;
  return r.start + offset;
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
  const ranges = opts.ranges ?? DEFAULT_RANGES;
  const reserved = opts.reserved ?? new Set<number>();
  const isInUse = opts.isInUse ?? isPortInUse;
  const r = rangeFor(service, ranges);
  let candidate = basePort(branch, service, ranges);
  for (let i = 0; i < PROBE_LIMIT; i++) {
    const probe = candidate + i;
    const wrapped = probe > r.end ? r.start + ((probe - r.start) % (r.end - r.start + 1)) : probe;
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

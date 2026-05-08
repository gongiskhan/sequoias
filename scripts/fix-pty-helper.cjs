// node-pty's prebuilt spawn-helper sometimes loses its execute bit during
// npm tarball extraction, which causes posix_spawnp to fail with a generic
// error. Re-set the bit defensively after install.
const fs = require('node:fs');
const path = require('node:path');

const platform = process.platform;
const arch = process.arch;
if (platform === 'win32') process.exit(0);

const helper = path.resolve(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'prebuilds',
  `${platform}-${arch}`,
  'spawn-helper',
);

try {
  fs.chmodSync(helper, 0o755);
} catch (err) {
  if (err && err.code === 'ENOENT') process.exit(0);
  process.stderr.write(`fix-pty-helper: ${err.message}\n`);
}

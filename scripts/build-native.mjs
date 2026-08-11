import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const buildScript = resolve(repositoryRoot, 'native', 'macos', 'build.sh');

if (process.platform !== 'darwin') {
  console.log('Skipping the macOS virtual-display helper on this platform.');
  process.exit(0);
}

const result = spawnSync('/bin/sh', [buildScript], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to start the native build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

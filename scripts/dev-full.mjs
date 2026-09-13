import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.TABLEWATCH_PYTHON ?? path.join(root, '.venv/bin/python');
if (!existsSync(python)) {
  console.error('Create .venv and install requirements.lock.txt and .[service,test] before starting TurnTable.');
  process.exit(1);
}
const children = [
  spawn(python, ['-m', 'service'], {cwd: root, stdio: 'inherit'}),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {cwd: root, stdio: 'inherit'}),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)))).then(() => process.exit(code));
  setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); process.exit(code); }, 5000).unref();
}
for (const child of children) { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code ?? 1)); }
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

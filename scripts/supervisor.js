// Simple supervisor that keeps `next dev` alive.
// If the child exits for any reason, it is restarted after 3 seconds.
const { spawn } = require('child_process');
const fs = require('fs');

const log = fs.createWriteStream('/home/z/my-project/dev.log', { flags: 'w' });

function ts() {
  return new Date().toISOString();
}

function startNext() {
  console.log(`[${ts()}] Starting next dev...`);
  const child = spawn(
    'node',
    ['node_modules/.bin/next', 'dev', '-p', '3000', '-H', '0.0.0.0'],
    {
      cwd: '/home/z/my-project',
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code, sig) => {
    console.log(`[${ts()}] next dev exited code=${code} sig=${sig}, restarting in 3s`);
    setTimeout(startNext, 3000);
  });
  child.unref();
}

startNext();
console.log(`[${ts()}] Supervisor started`);

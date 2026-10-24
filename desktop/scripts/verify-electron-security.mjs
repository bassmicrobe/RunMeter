// Isolated CI check: no Relay, credentials, user data or production app startup.
import assert from 'node:assert/strict';
import { get } from 'node:https';
import { app, net } from 'electron';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
try {
  assert.equal(process.versions.electron, manifest.devDependencies.electron);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0', false);
  assert.equal(app.commandLine.hasSwitch('ignore-certificate-errors'), false);
  await app.whenReady();
  const url = 'https://www.electronjs.org/';
  await new Promise((resolve, reject) => {
    const request = get(url, { rejectUnauthorized: true, timeout: 30000 }, response => {
      try {
        assert.equal(response.socket.authorized, true);
        assert.ok(response.statusCode < 500);
        response.resume();
        response.on('end', resolve);
      } catch (error) { response.resume(); reject(error); }
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Node TLS timeout')));
  });
  const response = await net.fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.status < 500);
  await response.body?.cancel();
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node,
    chrome: process.versions.chrome, nodeTLS: 'verified', chromiumTLS: 'verified' }));
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }

/**
 * CLI Tests: `start <ws-url>` honors --json on both outcomes
 *
 * The remote-connect branch printed straight to stdout/stderr instead of
 * going through printResult/printError, so a script driving `start` under
 * --json got neither a parsable object on success nor an error envelope on
 * failure. The local branch (`start` with no URL) always emitted the
 * envelope, which settles the intended shape.
 *
 * Runs its own daemon under an isolated VIBIUM_SESSION so the connect
 * attempts cannot disturb other test files.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { VIBIUM } = require('../helpers');

const SESSION = `start-json-test-${process.pid}`;
const ENV = { ...process.env, VIBIUM_SESSION: SESSION };

// A port the OS hands us is free right now, which keeps this file safe to run
// alongside the other suites the Makefile launches in parallel.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Poll until serve is actually accepting connections. A fixed sleep would be a
// coin flip once the Makefile runs this suite alongside the others.
async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`serve did not bind port ${port} within ${timeoutMs}ms`);
}

// Keep the streams apart. The envelope belongs on stdout so `--json | jq`
// works, and merging them would let a regression that moved it to stderr pass.
function run(args) {
  const r = spawnSync(VIBIUM, args, { encoding: 'utf-8', timeout: 90000, env: ENV });
  assert.strictEqual(r.error, undefined, `spawn failed: ${r.error}`);
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

let serveProcess, port;

describe('CLI: start <ws-url> honors --json', () => {
  before(async () => {
    port = await freePort();
    serveProcess = spawn(VIBIUM, ['serve', '--port', String(port), '--headless'], {
      stdio: 'ignore',
      env: ENV,
    });
    await waitForPort(port);
  });

  after(() => {
    spawnSync(VIBIUM, ['daemon', 'stop'], { encoding: 'utf-8', timeout: 30000, env: ENV });
    if (serveProcess) serveProcess.kill();
  });

  test('a successful connect emits the ok envelope, not human text', () => {
    const { stdout, status } = run(['start', `ws://localhost:${port}`, '--json']);
    const env = JSON.parse(stdout.trim()); // throws on the stock binary
    assert.strictEqual(env.ok, true, 'envelope should report ok');
    assert.match(env.result, /^Connected to /, 'result should carry the human message');
    assert.strictEqual(status, 0, 'a successful connect should exit 0');
  });

  test('a failed connect emits an error envelope and a non-zero exit', () => {
    // Port 1 is never listening, so this fails without needing a browser.
    const { stdout, stderr, status } = run(['start', 'ws://127.0.0.1:1/nope', '--json']);
    const env = JSON.parse(stdout.trim()); // throws on the stock binary
    assert.strictEqual(env.ok, false, 'envelope should report failure');
    assert.match(env.error, /failed to connect to ws:\/\/127\.0\.0\.1:1/, 'error should name the endpoint');
    assert.notStrictEqual(status, 0, 'a failed connect must not exit 0');
    // On stdout, not stderr: a script pipes stdout to jq and must still get the
    // error. This is the half of the contract the original fix left undone.
    assert.strictEqual(stderr.trim(), '', 'nothing should go to stderr under --json');
  });

  test('without --json the output stays human-readable', () => {
    const { stdout, stderr } = run(['start', 'ws://127.0.0.1:1/nope']);
    assert.match(stderr, /^Error: failed to connect to /, 'human mode reports on stderr');
    assert.doesNotMatch(stderr, /^\s*\{/, 'human mode must not emit an envelope');
    assert.strictEqual(stdout.trim(), '', 'nothing should go to stdout without --json');
  });
});

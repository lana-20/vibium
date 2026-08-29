/**
 * CLI Tests: -h/--help on commands that disable cobra flag parsing
 *
 * fill, type, geolocation, and sleep set DisableFlagParsing to support
 * negative-number positionals, which also bypasses cobra's built-in help
 * interception. Regression tests for #422 (bare --help returned an arity
 * error) and #423 (--help alongside positionals executed the command).
 *
 * All cases must short-circuit before any daemon call, so no browser or
 * daemon is needed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { VIBIUM } = require('../helpers');

function run(args) {
  const result = spawnSync(VIBIUM, args, {
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, VIBIUM_SESSION: `help-flags-test-${process.pid}` },
  });
  assert.strictEqual(result.error, undefined, `spawn failed: ${result.error}`);
  return result;
}

const COMMANDS = {
  fill: { short: 'Clear an input field', executed: /Filled/ },
  type: { short: 'Type text into an element', executed: /Typed/ },
  geolocation: { short: 'Override the browser geolocation', executed: /Geolocation set/ },
  sleep: { short: 'Pause execution', executed: /Slept/ },
};

function assertHelp(result, cmd, invocation) {
  const { short, executed } = COMMANDS[cmd];
  assert.strictEqual(result.status, 0, `${invocation}: expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /Usage:/, `${invocation}: help text should include usage`);
  assert.ok(result.stdout.includes(short), `${invocation}: help text should include the command description`);
  assert.doesNotMatch(result.stdout, executed, `${invocation}: command must not execute on a help request`);
  assert.doesNotMatch(result.stderr, /Error:/, `${invocation}: help request should not error`);
}

describe('CLI: help flags on DisableFlagParsing commands', () => {
  // #422: bare -h/--help must print help, not an arg-count error
  for (const cmd of Object.keys(COMMANDS)) {
    for (const flag of ['-h', '--help']) {
      test(`${cmd} ${flag} prints help`, () => {
        assertHelp(run([cmd, flag]), cmd, `${cmd} ${flag}`);
      });
    }
  }

  // #423: --help alongside positionals must print help, not execute
  test('sleep 5000 --help prints help without sleeping', () => {
    assertHelp(run(['sleep', '5000', '--help']), 'sleep', 'sleep 5000 --help');
  });

  test('fill <selector> <text> --help prints help without filling', () => {
    assertHelp(run(['fill', '#a', 'x', '--help']), 'fill', 'fill #a x --help');
  });

  test('fill --help <selector> <text> prints help (flag-first form)', () => {
    assertHelp(run(['fill', '--help', '#a', 'x']), 'fill', 'fill --help #a x');
  });

  test('type <selector> <text> -h prints help without typing', () => {
    assertHelp(run(['type', '#a', 'x', '-h']), 'type', 'type #a x -h');
  });

  test('geolocation 37 -122 --help prints help alongside a negative positional', () => {
    assertHelp(run(['geolocation', '37', '-122', '--help']), 'geolocation', 'geolocation 37 -122 --help');
  });

  // Guardrails: the behaviors DisableFlagParsing exists for must survive the fix
  test('negative numbers still parse as positionals, not flags', () => {
    const result = run(['geolocation', '-122']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /accepts 2 arg\(s\), received 1/);
    assert.doesNotMatch(result.stderr, /unknown flag/);
  });

  test('unknown flags are still rejected', () => {
    const result = run(['fill', '--bogusflag']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /unknown flag: --bogusflag/);
  });
});

describe('CLI: scroll help names its full surface (#445)', () => {
  test('all four directions and the real --selector meaning are in the help', () => {
    const result = spawnSync(VIBIUM, ['scroll', '--help'], { encoding: 'utf-8', timeout: 30000 });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /\[up\|down\|left\|right\]/, 'usage line should name the direction set');
    assert.match(result.stdout, /scroll within/, '--selector should say it scrolls within the element');
    assert.doesNotMatch(result.stdout, /element to scroll to\b/, 'the old scroll-to wording pointed at into-view');
  });
});

describe('CLI: mcp does not shadow the root --headless flag', () => {
  // mcp declared its own --headless, and cobra's InheritedFlags() skips any
  // parent flag a command already has. The flag therefore moved out of Global
  // Flags and picked up a second description -- mcp was the only command in
  // the CLI where that happened.
  function helpOf(cmd) {
    const result = spawnSync(VIBIUM, [cmd, '--help'], { encoding: 'utf-8', timeout: 30000 });
    assert.strictEqual(result.status, 0, `${cmd} --help should exit 0`);
    return result.stdout;
  }

  // Match only the flag's declaration line. The long description carries a
  // "vibium mcp --headless" usage example above the sections, so a substring
  // search would report the example's (absent) section instead.
  function sectionOf(help, flag) {
    const declaration = new RegExp(`^\\s+${flag}\\b`);
    let section = null;
    for (const line of help.split('\n')) {
      const heading = line.match(/^(Flags|Global Flags):/);
      if (heading) section = heading[1];
      else if (declaration.test(line)) return section;
    }
    return null;
  }

  test('--headless is declared once, under Global Flags like every other command', () => {
    const help = helpOf('mcp');
    const declarations = help.split('\n').filter((l) => /^\s+--headless\b/.test(l));
    assert.strictEqual(declarations.length, 1, 'a second declaration means the flag is shadowed again');
    assert.strictEqual(sectionOf(help, '--headless'), 'Global Flags', 'mcp should inherit, not redeclare');
  });

  test('mcp renders --headless the same way an ordinary command does', () => {
    const ordinary = sectionOf(helpOf('click'), '--headless');
    // Pin the comparison value so a help-format change cannot make this pass
    // by finding the flag in neither command.
    assert.strictEqual(ordinary, 'Global Flags', 'click is the baseline; it must inherit');
    assert.strictEqual(sectionOf(helpOf('mcp'), '--headless'), ordinary);
  });

  test('mcp still accepts --headless', () => {
    const result = spawnSync(VIBIUM, ['mcp', '--headless', '--help'], { encoding: 'utf-8', timeout: 30000 });
    assert.strictEqual(result.status, 0, 'the inherited flag must still parse');
  });
});

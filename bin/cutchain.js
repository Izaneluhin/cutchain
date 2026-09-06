#!/usr/bin/env node
'use strict';
/*
 * cutchain — thin dispatcher over the three modules of this repo.
 * No dependencies. Every subcommand spawns the real tool with stdio inherited.
 *
 *   cutchain watch [...]                 python3 -m watch ...               (cwd: repo root)
 *   cutchain replay                      python3 -m watch --replay data/demo_chat.log --speed 10
 *   cutchain board [--port 8788]         static server for board/
 *   cutchain launch|status|claim|pool    npx tsx mint/<cmd>.ts ...          (cwd: mint/)
 *   cutchain round <views.csv> <roundId> --total <wei> [...]   contracts/tooling/build_round.py
 *   cutchain test                        watch tests + forge test + mint typecheck
 *   cutchain doctor                      environment report
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WATCH_DIR = path.join(ROOT, 'watch');
const MINT_DIR = path.join(ROOT, 'mint');
const CONTRACTS_DIR = path.join(ROOT, 'contracts');
const BOARD_DIR = path.join(ROOT, 'board');
const ROUNDS_DIR = path.join(ROOT, 'rounds');
const BUILD_ROUND = path.join(CONTRACTS_DIR, 'tooling', 'build_round.py');

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const EXPECTED_CHAIN_ID = 4663; // 0x1237
const RPC_TIMEOUT_MS = 6000;

const IS_WIN = process.platform === 'win32';

const HELP = `cutchain <command> [args]

  watch [...]                       run the chat watcher (python3 -m watch ...), API on :8787
                                    e.g. cutchain watch --twitch clavicular,xqc --kick adinross
  replay                            replay watch/data/demo_chat.log at 10x, fires one moment
  board [--port 8788]               serve board/ on http://127.0.0.1:8788 (polls the watch API)
  launch [...]                      Pons V2 launch          (npx tsx mint/launch.ts ...)
  status [...]                      curve / graduation state (npx tsx mint/status.ts ...)
  claim [...]                       claim creator fees      (npx tsx mint/claim.ts ...)
  pool [...]                        Uniswap V3 side pool    (npx tsx mint/pool.ts ...)
  round <views.csv> <roundId> --total <wei> [--token 0x..] [--out path] [--quiet]
                                    build rounds/round_<roundId>.json (contracts/tooling/build_round.py)
  test                              watch tests, forge test (contracts/), npm run typecheck (mint/)
  doctor                            check python3, node, forge, deps, .env files, Robinhood Chain RPC
  help                              this text

Pass --help to watch/launch/status/claim/pool/round to see the underlying tool's flags.
`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function log(line) {
  process.stdout.write(line + '\n');
}

function fail(msg, code = 1) {
  process.stderr.write('cutchain: ' + msg + '\n');
  process.exit(code);
}

/** Find an executable on PATH (plus ~/.foundry/bin for forge/cast/anvil). Returns a full path or null. */
function findExe(name, extraDirs = []) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean).concat(extraDirs);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch (_) {
        /* not here */
      }
    }
  }
  return null;
}

function foundryDirs() {
  return [path.join(os.homedir(), '.foundry', 'bin')];
}

function findPython() {
  for (const name of ['python3', 'python']) {
    const exe = findExe(name);
    if (!exe) continue;
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    const m = out.match(/Python (\d+)\.(\d+)/);
    if (m && Number(m[1]) >= 3) return { exe, version: out.replace('Python ', '') };
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts.cwd || ROOT,
    env: Object.assign({}, process.env, opts.env || {}),
    shell: IS_WIN && /\.(cmd|bat)$/i.test(cmd),
  });
  if (r.error) {
    process.stderr.write(`cutchain: could not start ${cmd}: ${r.error.message}\n`);
    return 127;
  }
  if (r.signal) return 130;
  return r.status == null ? 1 : r.status;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// watch / replay
// ---------------------------------------------------------------------------

function cmdWatch(args) {
  const py = findPython();
  if (!py) fail('python3 not found (watch/ needs Python 3.11 and pip install -r watch/requirements.txt)');
  return run(py.exe, ['-m', 'watch', ...args], { cwd: ROOT });
}

function cmdReplay(args) {
  return cmdWatch(['--replay', 'data/demo_chat.log', '--speed', '10', ...args]);
}

// ---------------------------------------------------------------------------
// board: tiny static server, no deps
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function cmdBoard(args) {
  let port = 8788;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = Number(args[++i]);
    else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7));
    else if (args[i] === '--host' && args[i + 1]) host = args[++i];
    else if (args[i].startsWith('--host=')) host = args[i].slice(7);
    else if (args[i] === '--help' || args[i] === '-h') {
      log('cutchain board [--port 8788] [--host 127.0.0.1]\nServes the board/ folder. The board polls the watch API (default http://127.0.0.1:8787).');
      return 0;
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid --port');
  if (!exists(BOARD_DIR)) fail('board/ folder not found at ' + BOARD_DIR);
  if (!exists(path.join(BOARD_DIR, 'index.html'))) {
    process.stderr.write('cutchain: note: board/index.html is missing; the server will answer 404 until it exists\n');
  }

  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch (_) {
      res.writeHead(400).end('bad request');
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.normalize(path.join(BOARD_DIR, urlPath));
    if (!file.startsWith(BOARD_DIR + path.sep) && file !== BOARD_DIR) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + urlPath);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') fail(`port ${port} is already in use (try --port ${port + 1})`);
    fail(e.message);
  });
  server.listen(port, host, () => {
    log(`cutchain board: serving ${path.relative(process.cwd(), BOARD_DIR) || 'board'}/ at http://${host}:${port}/`);
    log('watch API expected at http://127.0.0.1:8787 (cutchain watch ... or cutchain replay). Ctrl+C to stop.');
  });
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null; // keep running
}

// ---------------------------------------------------------------------------
// mint: launch | status | claim | pool
// ---------------------------------------------------------------------------

function cmdMint(cmd, args) {
  if (!exists(path.join(MINT_DIR, cmd + '.ts'))) fail(`mint/${cmd}.ts not found`);
  if (!exists(path.join(MINT_DIR, 'node_modules'))) {
    fail('mint/node_modules is missing. Run: cd mint && npm install');
  }
  const npx = findExe('npx');
  if (!npx) fail('npx not found (Node.js >= 20 with npm is required)');
  return run(npx, ['tsx', cmd + '.ts', ...args], { cwd: MINT_DIR });
}

// ---------------------------------------------------------------------------
// round: build_round.py wrapper
// ---------------------------------------------------------------------------

function cmdRound(args) {
  const ROUND_HELP = `cutchain round <views.csv> <roundId> --total <wei> [--token 0x..] [--out path] [--quiet]

  views.csv   columns address,handle,views (contracts/tooling/views.example.csv)
  roundId     uint256 used on-chain, e.g. the ISO week 202637
  --total     payout for the round in wei / smallest token unit (5e21 accepted); required
  --token     payout token address; omit for an ETH round
  --out       output file (default rounds/round_<roundId>.json)
  --quiet     do not print the summary table

Runs: python3 contracts/tooling/build_round.py --csv <views.csv> --round <roundId> ...
`;
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    log(ROUND_HELP);
    return 0;
  }
  const [csvArg, roundId, ...rest] = args;
  if (!csvArg || roundId == null) fail('usage: cutchain round <views.csv> <roundId> --total <wei> [...]');
  if (!/^\d+$/.test(roundId)) fail(`roundId must be a non-negative integer, got ${JSON.stringify(roundId)}`);
  const csv = path.resolve(process.cwd(), csvArg);
  if (!exists(csv)) fail(`CSV not found: ${csv}`);
  if (!exists(BUILD_ROUND)) fail(`${BUILD_ROUND} not found`);

  const passthrough = [];
  let hasTotal = false;
  let hasOut = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--total' || a.startsWith('--total=')) hasTotal = true;
    if (a === '--out' || a.startsWith('--out=')) {
      hasOut = true;
      if (a === '--out' && rest[i + 1]) {
        passthrough.push('--out', path.resolve(process.cwd(), rest[++i]));
        continue;
      }
      if (a.startsWith('--out=')) {
        passthrough.push('--out', path.resolve(process.cwd(), a.slice(6)));
        continue;
      }
    }
    passthrough.push(a);
  }
  if (!hasTotal) {
    fail('--total <wei> is required (read it with: cast call $DISTRIBUTOR "available(address)(uint256)" <token|0x0..0> --rpc-url $RPC_URL)');
  }
  if (!hasOut) {
    if (!exists(ROUNDS_DIR)) fs.mkdirSync(ROUNDS_DIR, { recursive: true });
    passthrough.push('--out', path.join(ROUNDS_DIR, `round_${roundId}.json`));
  }
  const py = findPython();
  if (!py) fail('python3 not found');
  return run(py.exe, [BUILD_ROUND, '--csv', csv, '--round', roundId, ...passthrough], { cwd: ROOT });
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

function banner(title) {
  log('');
  log('=== ' + title + ' ' + '='.repeat(Math.max(0, 70 - title.length)));
}

function cmdTest() {
  const results = [];

  banner('watch: python -m watch.tests.test_watch');
  const py = findPython();
  if (!py) {
    log('SKIP    python3 not found');
    results.push(['watch', 'skipped']);
  } else {
    const code = run(py.exe, ['-m', 'watch.tests.test_watch'], { cwd: ROOT });
    results.push(['watch', code === 0 ? 'ok' : `failed (exit ${code})`]);
  }

  banner('contracts: forge test -vv');
  const forge = findExe('forge', foundryDirs());
  if (!forge) {
    log('SKIP    forge not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup');
    results.push(['contracts', 'skipped (forge missing)']);
  } else {
    if (!exists(path.join(CONTRACTS_DIR, 'lib', 'forge-std'))) {
      log('note    contracts/lib/forge-std is missing; run: cd contracts && forge install foundry-rs/forge-std@v1.9.7 --no-git');
    }
    const code = run(forge, ['test', '-vv'], { cwd: CONTRACTS_DIR });
    results.push(['contracts', code === 0 ? 'ok' : `failed (exit ${code})`]);
  }

  banner('mint: npm run typecheck');
  if (!exists(path.join(MINT_DIR, 'node_modules'))) {
    log('SKIP    mint/node_modules is missing. Run: cd mint && npm install');
    results.push(['mint', 'skipped (node_modules missing)']);
  } else {
    const npm = findExe('npm');
    if (!npm) {
      log('SKIP    npm not found');
      results.push(['mint', 'skipped (npm missing)']);
    } else {
      const code = run(npm, ['run', 'typecheck'], { cwd: MINT_DIR });
      results.push(['mint', code === 0 ? 'ok' : `failed (exit ${code})`]);
    }
  }

  banner('summary');
  let failed = false;
  for (const [name, status] of results) {
    log(`${name.padEnd(10)} ${status}`);
    if (status.startsWith('failed')) failed = true;
  }
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function line(ok, label, detail) {
  log(`${ok ? 'OK     ' : 'MISSING'}  ${label.padEnd(26)} ${detail || ''}`.trimEnd());
}

function probeChainId(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
      const req = mod.request(
        u,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            data += c;
            if (data.length > 65536) req.destroy();
          });
          res.on('end', () => {
            try {
              const j = JSON.parse(data);
              if (j && typeof j.result === 'string') done({ ok: true, chainId: parseInt(j.result, 16) });
              else done({ ok: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 120)}` });
            } catch (e) {
              done({ ok: false, error: `HTTP ${res.statusCode}, no JSON-RPC reply (proxy or firewall?)` });
            }
          });
          res.on('error', (e) => done({ ok: false, error: e.message }));
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error('timeout after ' + timeoutMs + ' ms'));
      });
      req.on('error', (e) => done({ ok: false, error: e.message }));
      req.end(body);
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });
}

async function cmdDoctor() {
  log('cutchain doctor');
  log('');

  // python
  const py = findPython();
  if (py) {
    const m = py.version.match(/^(\d+)\.(\d+)/);
    const recent = m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 11));
    line(true, 'python3', `${py.version}${recent ? '' : ' (watch/ targets 3.11)'}`);
  } else {
    line(false, 'python3', 'install Python 3.11+');
  }
  if (py) {
    const r = spawnSync(py.exe, ['-c', 'import websockets, aiohttp, yaml'], { encoding: 'utf8' });
    line(r.status === 0, 'watch deps', r.status === 0 ? 'websockets, aiohttp, pyyaml' : 'pip install -r watch/requirements.txt');
  }

  // node
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20, 'node >= 20', `v${process.versions.node}${major >= 20 && major < 22 ? ' (mint/ declares node >=22)' : ''}`);
  const npm = findExe('npm');
  line(!!npm, 'npm', npm || 'install Node.js with npm');

  // foundry
  const forge = findExe('forge', foundryDirs());
  if (forge) {
    const r = spawnSync(forge, ['--version'], { encoding: 'utf8' });
    const v = ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
    line(true, 'forge', v || forge);
  } else {
    line(false, 'forge', 'curl -L https://foundry.paradigm.xyz | bash && foundryup');
  }
  const cast = findExe('cast', foundryDirs());
  line(!!cast, 'cast', cast ? 'found' : 'comes with Foundry (needed for setRound / claim / sweep)');
  const forgeStd = exists(path.join(CONTRACTS_DIR, 'lib', 'forge-std', 'src'));
  line(forgeStd, 'contracts/lib/forge-std', forgeStd ? 'installed' : 'cd contracts && forge install foundry-rs/forge-std@v1.9.7 --no-git');

  // mint
  const nm = exists(path.join(MINT_DIR, 'node_modules'));
  line(nm, 'mint/node_modules', nm ? 'installed' : 'cd mint && npm install');

  // env files
  for (const rel of ['watch/.env', 'mint/.env', 'contracts/.env']) {
    const present = exists(path.join(ROOT, rel));
    line(present, rel, present ? 'present' : `cp ${rel}.example ${rel}`);
  }

  // rpc
  const rpc = await probeChainId(RPC_URL, RPC_TIMEOUT_MS);
  if (rpc.ok && rpc.chainId === EXPECTED_CHAIN_ID) {
    line(true, 'Robinhood Chain RPC', `${RPC_URL} chainId ${rpc.chainId}`);
  } else if (rpc.ok) {
    line(false, 'Robinhood Chain RPC', `${RPC_URL} answered chainId ${rpc.chainId}, expected ${EXPECTED_CHAIN_ID}`);
  } else {
    line(false, 'Robinhood Chain RPC', `${RPC_URL} unreachable: ${rpc.error}`);
  }

  log('');
  log('MISSING lines are hints, not errors: .env files are only needed for live clips / live sends / deploys.');
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      log(HELP);
      return 0;
    case 'watch':
      return cmdWatch(args);
    case 'replay':
      return cmdReplay(args);
    case 'board':
      return cmdBoard(args);
    case 'launch':
    case 'status':
    case 'claim':
    case 'pool':
      return cmdMint(cmd, args);
    case 'round':
      return cmdRound(args);
    case 'test':
      return cmdTest();
    case 'doctor':
      return cmdDoctor();
    default:
      process.stderr.write(`cutchain: unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => {
    if (code !== null && code !== undefined) process.exit(code);
  },
  (e) => {
    process.stderr.write('cutchain: ' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.exit(1);
  },
);

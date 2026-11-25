// Token launch radar: the program behind the dashboard.
//
// It reads the sealed snapshot (at /input/snapshot.json, or wherever --input points), scores every
// launch candidate with lib/model.ts, and writes the handover into the output directory:
//   board.json    the ranked board, one row per protocol, each with its implied value and farm plan
//   data.js       the same board in the compact shape the dashboard renders
//   dashboard/    this repository's static page, copied across
//   screenshots/  this repository's three screenshots, copied across
//   dossier.json  written last, from vendor/makefun-board.ts, over the files above
//
// The board is checked against the gate's shape before anything is written: a board the gate would
// refuse is a failed run, not a submission. Node 22, standard library only, no network.
//
// Run it outside the grader like this:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The caps the scorer holds a dossier to; the text cap is the only one that shapes bytes. */
const DOSSIER_TEXT_BYTES = 65_536;
const DOSSIER_SCREENSHOTS = { max: 4, max_bytes: 524_288 };
const DOSSIER_DASHBOARD = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A `--name value` or `--name=value` argument, else the fallback. */
function readArg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 3);
}

function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

const inputArg = readArg('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const outDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`, 1);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory's plain files (no dot names, no nesting) into the output; returns the names copied. */
function copyFlat(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    names.push(name);
  }
  return names;
}

const pageFiles = copyFlat(join(repoDir, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyFlat(join(repoDir, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
}

// The dossier goes last on purpose: it is built from the dashboard and screenshots as they now
// stand in the output, and the scorer rebuilds it the same way and compares bytes.
const dossier = buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_BYTES, screenshots: DOSSIER_SCREENSHOTS, dashboard: DOSSIER_DASHBOARD });
writeFileSync(join(outDir, 'dossier.json'), dossier);

/** Re-read the board as written and prove it is the board the gate passed: same rows, ranks 1..N
 *  with no gaps, and every watchlist slug present exactly once. A short or duplicated board on
 *  disk is a failed run, however clean the in-memory copy looked. Returns the verified row count. */
function verifyWrittenBoard(path: string): number {
  const written = JSON.parse(readFileSync(path, 'utf8')) as { rows?: unknown };
  if (!Array.isArray(written.rows)) fail('the written board.json has no rows array', 1);
  const rows = written.rows as { slug: string; rank: number }[];
  if (rows.length !== board.length) fail(`the written board holds ${rows.length} rows, the model ranked ${board.length}`, 1);
  const seen = new Set<string>();
  rows.forEach((row, at) => {
    if (row.rank !== at + 1) fail(`the written board's ranks break at row ${at + 1}: rank ${row.rank}`, 1);
    if (seen.has(row.slug)) fail(`the written board repeats ${row.slug}`, 1);
    seen.add(row.slug);
  });
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) fail(`the written board lost the watchlist protocol ${slug}`, 1);
  }
  return rows.length;
}

const verifiedRows = verifyWrittenBoard(join(outDir, 'board.json'));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols scanned, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked (${radar.early_size} of them below the ${'$'}${snapshot.floor_usd.toLocaleString('en-US')} floor)\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images) and dossier.json to ${outDir}; the written board re-reads clean at ${verifiedRows} rows\n`,
);

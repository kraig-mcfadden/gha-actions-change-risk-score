#!/usr/bin/env node
// Compute CRAP change-risk scores per function for a JS/TS (and optionally
// Svelte) project. Complexity comes from ESLint's built-in `complexity` rule
// using the Node API. Coverage is read from an lcov.info file (the format
// emitted by c8, Vitest, Jest, nyc). Per-function coverage is computed by
// intersecting each function's line range with lcov's DA records.

import { ESLint } from 'eslint';
import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function normPath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseLcov(content) {
  const files = new Map();
  let current = null;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = { filename: line.slice(3), lines: new Map() };
    } else if (line.startsWith('DA:') && current) {
      const [n, h] = line.slice(3).split(',');
      current.lines.set(Number(n), Number(h));
    } else if (line === 'end_of_record' && current) {
      files.set(normPath(current.filename), current.lines);
      current = null;
    }
  }
  return files;
}

function findFile(coverage, filename) {
  const key = normPath(filename);
  if (coverage.has(key)) return coverage.get(key);
  for (const [candidate, lines] of coverage) {
    if (candidate.endsWith(key) || key.endsWith(candidate)) return lines;
  }
  return null;
}

function functionCoverage(linesMap, start, end) {
  if (!linesMap) return null;
  let total = 0;
  let covered = 0;
  for (const [n, h] of linesMap) {
    if (n >= start && n <= end) {
      total++;
      if (h > 0) covered++;
    }
  }
  if (total === 0) return null;
  return (covered / total) * 100;
}

function crap(complexity, coveragePct) {
  return complexity * complexity * Math.pow(1 - coveragePct / 100, 3) + complexity;
}

const FN_NAME_RE = /(?:Async generator function|Async generator method|Generator function|Generator method|Async arrow function|Arrow function|Async function|Async method|Function|Method)\s*(?:'([^']+)')?/;
const COMPLEXITY_RE = /complexity of (\d+)/;

function extractFnInfo(message) {
  const nameMatch = message.match(FN_NAME_RE);
  const complexityMatch = message.match(COMPLEXITY_RE);
  return {
    name: (nameMatch && nameMatch[1]) || '<anonymous>',
    complexity: complexityMatch ? Number(complexityMatch[1]) : 0,
  };
}

async function buildConfig({ svelte }) {
  const tsParserMod = await import('@typescript-eslint/parser');
  const tsParser = tsParserMod.default ?? tsParserMod;

  const config = [
    {
      files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      rules: { complexity: ['error', 0] },
    },
    {
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
      rules: { complexity: ['error', 0] },
    },
  ];

  if (svelte) {
    const svelteParserMod = await import('svelte-eslint-parser');
    const svelteParser = svelteParserMod.default ?? svelteParserMod;
    config.push({
      files: ['**/*.svelte'],
      languageOptions: {
        parser: svelteParser,
        parserOptions: { parser: tsParser },
      },
      rules: { complexity: ['error', 0] },
    });
  }

  return config;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = args['source-path'];
  const coveragePath = args['coverage-lcov'];
  const threshold = Number(args['threshold']);
  const top = args['top'] && args['top'].trim() !== '' ? Number(args['top']) : Infinity;
  const missingPolicy = args['missing-policy'] || 'pessimistic';
  const outputFile = args['output-file'];
  const violationsFile = args['violations-file'];
  const svelte = args['svelte'] === 'true';
  const extensions = (args['extensions'] || 'js,jsx,mjs,cjs,ts,tsx,mts,cts')
    .split(',')
    .map((e) => '.' + e.trim())
    .filter((e) => e.length > 1);
  if (svelte && !extensions.includes('.svelte')) extensions.push('.svelte');

  let coverageText;
  try {
    coverageText = await readFile(coveragePath, 'utf8');
  } catch (e) {
    console.error(`error: could not read lcov coverage file at ${coveragePath}: ${e.message}`);
    process.exit(2);
  }
  const coverageData = parseLcov(coverageText);

  const overrideConfig = await buildConfig({ svelte });
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig,
    errorOnUnmatchedPattern: false,
  });

  const results = await eslint.lintFiles([sourcePath]);

  const scores = [];
  for (const result of results) {
    const fileRel = normPath(relative(process.cwd(), result.filePath));
    if (!extensions.some((ext) => fileRel.endsWith(ext))) continue;
    const linesMap = findFile(coverageData, fileRel);
    for (const m of result.messages) {
      if (m.ruleId !== 'complexity') continue;
      const { name, complexity } = extractFnInfo(m.message);
      const start = m.line;
      const end = m.endLine ?? start;
      let coveragePct = functionCoverage(linesMap, start, end);
      if (coveragePct == null) {
        if (missingPolicy === 'skip') continue;
        coveragePct = missingPolicy === 'pessimistic' ? 0 : 100;
      }
      scores.push({
        file: fileRel,
        function: name,
        line: start,
        complexity,
        coverage: coveragePct,
        crap: crap(complexity, coveragePct),
      });
    }
  }

  scores.sort((a, b) => b.crap - a.crap);
  const violations = scores.filter((s) => s.crap > threshold);
  const displayed = scores.slice(0, Math.min(top, scores.length));

  const lines = [];
  lines.push('## Change Risk Score (JavaScript/TypeScript)');
  lines.push('');
  lines.push(
    `Threshold **${threshold}** · Functions analyzed **${scores.length}** · Above threshold **${violations.length}**`,
  );
  lines.push('');
  if (displayed.length) {
    lines.push('| CRAP | Complexity | Coverage | Function | Location |');
    lines.push('|---:|---:|---:|---|---|');
    for (const s of displayed) {
      const mark = s.crap > threshold ? ' :warning:' : '';
      lines.push(
        `| ${s.crap.toFixed(1)}${mark} | ${s.complexity} | ${s.coverage.toFixed(1)}% | \`${s.function}\` | \`${s.file}:${s.line}\` |`,
      );
    }
    if (scores.length > displayed.length) {
      lines.push('');
      lines.push(`_…and ${scores.length - displayed.length} more functions._`);
    }
  } else {
    lines.push('_No functions analyzed._');
  }

  await writeFile(outputFile, lines.join('\n') + '\n');
  await writeFile(
    violationsFile,
    violations.length
      ? violations
          .map(
            (v) =>
              `${v.file}:${v.line} ${v.function} CRAP=${v.crap.toFixed(1)} complexity=${v.complexity} coverage=${v.coverage.toFixed(1)}%`,
          )
          .join('\n') + '\n'
      : '',
  );

  console.log(`Analyzed ${scores.length} functions; ${violations.length} above threshold ${threshold}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

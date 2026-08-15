import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const runs = new Map();
const maxOutput = 24_000;
const ignored = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', 'coverage']);

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function command(bin, args, cwd, timeout = 120_000, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const add = (data) => { output = (output + data).slice(-maxOutput); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${error.message}`, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output, timedOut: signal === 'SIGTERM' });
    });
  });
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function listFiles(dir, prefix = '', files = []) {
  if (files.length >= 250) return files;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(absolute, relative, files);
    else if (entry.isFile()) files.push(relative.replaceAll('\\', '/'));
    if (files.length >= 250) break;
  }
  return files;
}

async function inspectRepository(repoDir) {
  const files = await listFiles(repoDir);
  const packageJson = await readJson(path.join(repoDir, 'package.json'));
  const has = (name) => files.some((file) => file === name || file.endsWith(`/${name}`));
  let test = null;
  let framework = 'No supported test configuration detected';
  if (packageJson?.scripts?.test) {
    framework = 'Node.js package test script';
    test = { bin: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'] };
  } else if (has('pytest.ini') || has('pyproject.toml') || files.some((f) => /^test_.*\.py$/.test(path.basename(f)))) {
    framework = 'Python / pytest';
    test = { bin: process.platform === 'win32' ? 'py' : 'python', args: ['-m', 'pytest'] };
  } else if (has('pom.xml')) {
    framework = 'Maven'; test = { bin: process.platform === 'win32' ? 'mvn.cmd' : 'mvn', args: ['test'] };
  } else if (has('build.gradle') || has('build.gradle.kts')) {
    framework = 'Gradle'; test = { bin: process.platform === 'win32' ? 'gradlew.bat' : './gradlew', args: ['test'] };
  } else if (has('go.mod')) {
    framework = 'Go'; test = { bin: 'go', args: ['test', './...'] };
  }
  return { files, framework, test, packageJson };
}

function makePlan(issue, analysis) {
  const samples = analysis.files.slice(0, 30);
  return [
    `Review the relevant application and test files from: ${samples.join(', ') || '(repository contains no source files)'}.`,
    `Trace the behavior implicated by “${issue.title}” and identify the smallest safe change.`,
    'Implement the change and add or update focused tests where the project convention supports it.',
    `Validate with ${analysis.framework}.`,
    'Review the resulting diff for scope, correctness, and unintended changes.'
  ];
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'issue';
}

async function invokeCodex(repoDir, issue, plan, repairOutput = null) {
  const prompt = repairOutput
    ? `The tests failed after your implementation. Repair the issue in this repository. Test output:\n${repairOutput}\nDo not change unrelated files.`
    : `Implement this issue in the repository at your working directory.\nTitle: ${issue.title}\nDescription: ${issue.description}\nPlan:\n${plan.map((step, i) => `${i + 1}. ${step}`).join('\n')}\nWork directly in the repository. Keep the change focused and add tests when appropriate.`;
  const localCodexCli = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const configuredCodex = process.env.CODEX_CLI_PATH;
  const result = await command(
    configuredCodex || process.execPath,
    [...(configuredCodex ? [] : [localCodexCli]), 'exec', '--ephemeral', '--sandbox', 'workspace-write', prompt],
    repoDir,
    180_000,
    {
      ...process.env,
      HOME: process.env.HOME || homedir(),
      CODEX_HOME: process.env.CODEX_HOME || path.join(homedir(), '.codex')
    }
  );
  if (result.code !== 0 || /Error finding codex home|failed to initialize in-process app-server client/i.test(result.output)) {
    throw new Error(`OpenAI Codex CLI failed:\n${result.output}`);
  }
  return { summary: result.output.trim() || 'OpenAI Codex completed the requested change.' };
}

async function createPullRequest(repoUrl, branch, title, body) {
  if (!process.env.GITHUB_TOKEN) return { skipped: 'GITHUB_TOKEN is not configured.' };
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/);
  if (!match) return { skipped: 'PR creation currently supports HTTPS GitHub repository URLs only.' };
  const [, owner, repo] = match;
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ title, head: branch, base: 'main', body })
  });
  if (!response.ok) return { skipped: `GitHub rejected PR creation: ${await response.text()}` };
  const pr = await response.json();
  return { url: pr.html_url };
}

async function executeRun(run) {
  const { repoUrl, title, description, createPr } = run.input;
  run.status = 'cloning';
  run.workspace = await mkdtemp(path.join(tmpdir(), 'issuepilot-'));
  const repoDir = path.join(run.workspace, 'repository');
  const clone = await command('git', ['clone', '--depth', '1', repoUrl, repoDir], run.workspace);
  if (clone.code !== 0) throw new Error(`Clone failed:\n${clone.output}`);

  run.status = 'analyzing';
  run.analysis = await inspectRepository(repoDir);
  run.plan = makePlan({ title, description }, run.analysis);
  run.status = 'implementing';
  run.codex = await invokeCodex(repoDir, { title, description }, run.plan);

  run.repairs = [];
  run.status = 'testing';
  if (!run.analysis.test) run.tests = { skipped: `No test command detected (${run.analysis.framework}).` };
  else {
    run.tests = await command(run.analysis.test.bin, run.analysis.test.args, repoDir);
    for (let attempt = 1; run.tests.code !== 0 && attempt <= 3; attempt += 1) {
      run.status = `repairing (${attempt}/3)`;
      const repair = await invokeCodex(repoDir, { title, description }, run.plan, run.tests.output);
      run.repairs.push(repair);
      run.status = 'testing';
      run.tests = await command(run.analysis.test.bin, run.analysis.test.args, repoDir);
    }
  }

  run.status = 'reviewing diff';
  run.diff = await command('git', ['diff', '--no-ext-diff'], repoDir);
  const changed = await command('git', ['status', '--short'], repoDir);
  if (!changed.output.trim()) {
    run.commit = { skipped: 'No repository changes were produced, so no branch or commit was created.' };
  } else if (run.tests.code === 0 || run.tests.skipped) {
    run.status = 'committing';
    const branch = `issuepilot/${slug(title)}-${randomUUID().slice(0, 6)}`;
    const branchResult = await command('git', ['checkout', '-b', branch], repoDir);
    if (branchResult.code !== 0) throw new Error(`Branch creation failed:\n${branchResult.output}`);
    await command('git', ['add', '--all'], repoDir);
    const commit = await command('git', ['commit', '-m', `fix: ${title.slice(0, 70)}`], repoDir);
    if (commit.code !== 0) throw new Error(`Commit failed:\n${commit.output}`);
    run.commit = { branch, output: commit.output };
    if (createPr) run.pullRequest = await createPullRequest(repoUrl, branch, title, description);
  } else {
    run.commit = { skipped: 'Tests still fail after three repairs; changes were not committed.' };
  }
  run.status = 'complete';
}

function safeRun(run) {
  const { workspace, ...visible } = run;
  return visible;
}

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/runs') {
    try {
      const input = await body(req);
      if (!/^https:\/\/github\.com\/.+/.test(input.repoUrl || '') || !input.title?.trim() || !input.description?.trim()) {
        return json(res, 400, { error: 'Provide a GitHub HTTPS repository URL, issue title, and description.' });
      }
      const run = { id: randomUUID(), input: { repoUrl: input.repoUrl.trim(), title: input.title.trim(), description: input.description.trim(), createPr: Boolean(input.createPr) }, status: 'queued', startedAt: new Date().toISOString() };
      runs.set(run.id, run);
      executeRun(run).catch((error) => { run.status = 'failed'; run.error = error.message; }).finally(() => setTimeout(() => rm(run.workspace, { recursive: true, force: true }), 60 * 60 * 1000));
      return json(res, 202, safeRun(run));
    } catch { return json(res, 400, { error: 'Request body must be valid JSON.' }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
    const run = runs.get(url.pathname.split('/').pop());
    return run ? json(res, 200, safeRun(run)) : json(res, 404, { error: 'Run not found.' });
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const absolute = path.resolve(publicDir, file);
  if (!absolute.startsWith(publicDir + path.sep) && absolute !== path.join(publicDir, 'index.html')) return json(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': absolute.endsWith('.css') ? 'text/css' : absolute.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    createReadStream(absolute).pipe(res);
  } catch { json(res, 404, { error: 'Not found' }); }
});

server.listen(process.env.PORT || 3000, () => console.log(`IssuePilot running at http://localhost:${process.env.PORT || 3000}`));

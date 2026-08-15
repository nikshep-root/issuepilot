const form = document.querySelector('#run-form');
const result = document.querySelector('#result');
let timer;

const escape = (value = '') => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function output(title, text, expanded = false) { return `<details ${expanded ? 'open' : ''}><summary>${escape(title)}</summary><pre>${escape(text || 'No output')}</pre></details>`; }
function render(run) {
  result.classList.remove('hidden');
  const done = ['complete', 'failed'].includes(run.status);
  result.innerHTML = `<div class="status ${done ? run.status : ''}"><span></span>${escape(run.status)}</div>${run.error ? `<p class="error">${escape(run.error)}</p>` : ''}${run.analysis ? `<h2>Repository analysis</h2><p>${escape(run.analysis.framework)} · ${run.analysis.files.length} files sampled</p>${output('Relevant files', run.analysis.files.join('\n'))}` : ''}${run.plan ? `<h2>Implementation plan</h2><ol>${run.plan.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>` : ''}${run.tests ? `<h2>Tests</h2><p>${run.tests.skipped ? escape(run.tests.skipped) : `Exit code: ${run.tests.code}`}</p>${run.tests.output ? output('Test output', run.tests.output, run.tests.code !== 0) : ''}` : ''}${run.diff ? `<h2>Final diff</h2>${output('View diff', run.diff.output, true)}` : ''}${run.commit ? `<h2>Commit</h2><p>${escape(run.commit.branch ? `Created ${run.commit.branch}` : run.commit.skipped)}</p>${run.pullRequest?.url ? `<p><a href="${escape(run.pullRequest.url)}" target="_blank" rel="noreferrer">Open pull request</a></p>` : ''}` : ''}`;
}
async function poll(id) { const run = await fetch(`/api/runs/${id}`).then((r) => r.json()); render(run); if (!['complete', 'failed'].includes(run.status)) timer = setTimeout(() => poll(id), 1200); }
form.addEventListener('submit', async (event) => { event.preventDefault(); clearTimeout(timer); const data = Object.fromEntries(new FormData(form)); data.createPr = Boolean(data.createPr); const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); const run = await response.json(); if (!response.ok) { render({ status: 'failed', error: run.error }); return; } form.querySelector('button').disabled = true; render(run); await poll(run.id); form.querySelector('button').disabled = false; });

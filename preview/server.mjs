import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PREVIEW_PORT || 41773);
const sources = ['Main.gs', 'Api.gs', 'Webhook.gs', 'Ai.gs'].map((name) => readFileSync(path.join(root, name), 'utf8')).join('\n');
const page = readFileSync(path.join(root, 'Index.html'), 'utf8');

const sample = `
window.__CT_PREVIEW__ = true;
var SAMPLE_ROWS = [
  { repo: 'sample-org/tower-notes', url: 'https://github.com/sample-org/tower-notes', description: 'Sample notes app used only in the local preview.', visibility: 'Public', stars: 12, fork: 'No', topics: 'apps-script, sheets', hasReadme: 'Yes', hasCi: 'Yes', deployStatus: 'Live', security: '0', category: 'Tools', stack: 'Apps Script', score: 8, priority: 'P1', plan: 'Keep the webhook path small.' },
  { repo: 'sample-org/nvidia-inference-demo', url: 'https://github.com/sample-org/nvidia-inference-demo', description: 'Sample GPU demo so the NVIDIA KPI has something to count.', visibility: 'Public', stars: 40, fork: 'No', topics: 'nvidia, triton', hasReadme: 'Yes', hasCi: 'Yes', deployStatus: 'Deployed', security: '1', category: 'NVIDIA', stack: 'Python, Triton', score: 9, priority: 'P1 this week', plan: 'Track deploy workflow.' },
  { repo: 'sample-org/cloud-run-status', url: 'https://github.com/sample-org/cloud-run-status', description: 'Sample Cloud Run service.', visibility: 'Private', stars: 2, fork: 'No', topics: 'gcp, cloud run', hasReadme: 'Yes', hasCi: 'No', deployStatus: 'Failed', security: '', category: 'Google Cloud', stack: 'Go', score: 7, priority: 'P2', plan: 'Fix the release workflow.' },
  { repo: 'sample-org/vertex-notebooks', url: 'https://github.com/sample-org/vertex-notebooks', description: 'Sample Vertex and BigQuery workspace.', visibility: 'Private', stars: 1, fork: 'Yes', topics: 'bigquery, vertex', hasReadme: 'No', hasCi: '', deployStatus: 'Ready to deploy', security: '', category: 'Research', stack: 'Python', score: 6, priority: 'P3', plan: '' },
  { repo: 'sample-org/readme-only', url: '', description: 'Sample row with no URL, so the empty-link state is visible.', visibility: 'Public', stars: 0, fork: 'No', topics: '', hasReadme: 'Yes', hasCi: 'Yes', deployStatus: '', security: '', category: 'Learning', stack: '', score: '', priority: 'Later', plan: 'Add the GitHub URL.' },
  { repo: 'sample-org/unclassified-notes', url: 'https://github.com/sample-org/unclassified-notes', description: 'Sample row with no priority so Classify next N has a target.', visibility: 'Public', stars: 0, fork: 'No', topics: 'notes', hasReadme: 'Yes', hasCi: 'No', deployStatus: '', security: '', category: 'Learning', stack: '', score: '', priority: '', plan: '' }
];
var PREVIEW_CLASSIFICATION = '{"priority":"P2","tech_stack":"Apps Script, Sheets","deploy_status":"demo","rationale":"Preview sample only. No live model was called.","tags":["preview"]}';
function previewClassifyRow(row) {
  var parsed = parseGeminiClassification_(PREVIEW_CLASSIFICATION);
  if (!parsed.ok) return { ok: false, repo: row.repo, error: parsed.error };
  var patch = classificationSheetPatch_(parsed.classification, row);
  if (patch.priority) row.priority = patch.priority;
  if (patch.stack) row.stack = patch.stack;
  if (patch.deployStatus) row.deployStatus = patch.deployStatus;
  return { ok: true, repo: row.repo, classification: parsed.classification, updated: Object.keys(patch) };
}
var SAMPLE_PRIORITIES = {
  missing: false,
  sheetName: 'Today & Priorities',
  headerRow: 1,
  headers: ['Repo', 'Priority', 'Status', 'Next'],
  columns: { repo: 0, status: 2 },
  editable: true,
  rows: [
    { rowNumber: 2, values: ['sample-org/tower-notes', 'P1', 'In progress', 'Confirm webhook log'], repo: 'sample-org/tower-notes', status: 'In progress' },
    { rowNumber: 3, values: ['sample-org/cloud-run-status', 'P2', 'Blocked', 'Read the failed run'], repo: 'sample-org/cloud-run-status', status: 'Blocked' },
    { rowNumber: 4, values: ['sample-org/vertex-notebooks', 'P3', '', 'Decide if it ships'], repo: 'sample-org/vertex-notebooks', status: '' }
  ]
};
var SAMPLE_DEPLOY = {
  missing: false,
  sheetName: 'Deploy Tracker',
  headerRow: 1,
  headers: ['Repo', 'Target', 'Status', 'URL'],
  columns: { repo: 0, status: 2 },
  editable: false,
  rows: [
    { rowNumber: 2, values: ['sample-org/tower-notes', 'Apps Script', 'Live', 'https://script.google.com/macros/s/preview/exec'], repo: 'sample-org/tower-notes', status: 'Live' },
    { rowNumber: 3, values: ['sample-org/cloud-run-status', 'Cloud Run', 'Failed', 'https://github.com/sample-org/cloud-run-status/actions'], repo: 'sample-org/cloud-run-status', status: 'Failed' }
  ]
};
var SAMPLE_EVENTS = [
  { timestamp: '2026-09-30 18:06:40', event: 'push', repo: 'sample-org/tower-notes', action: 'push', result: 'updated', detail: '' },
  { timestamp: '2026-09-30 18:05:12', event: 'workflow_run', repo: 'sample-org/nvidia-inference-demo', action: 'completed', result: 'updated', detail: '' },
  { timestamp: '2026-09-30 18:04:00', event: 'ping', repo: '', action: 'ping', result: 'pong', detail: '' }
];
function makeRunner() {
  var ok = function () {};
  var fail = function () {};
  var runner = {
    withSuccessHandler: function (fn) { ok = fn; return runner; },
    withFailureHandler: function (fn) { fail = fn; return runner; },
    getOverviewMetrics: function () {
      var data = buildOverview_(SAMPLE_ROWS);
      data.generatedAt = '2026-09-30 18:10:00';
      data.editable = true;
      ok(data);
    },
    getInventoryRows: function (filters) {
      var filtered = filterInventory_(SAMPLE_ROWS, normalizeFilters_(filters));
      ok({
        rows: filtered.map(publicInventoryRow_),
        total: SAMPLE_ROWS.length,
        matched: filtered.length,
        options: inventoryOptions_(SAMPLE_ROWS),
        editable: true,
        generatedAt: '2026-09-30 18:10:00'
      });
    },
    getPriorities: function () { ok(SAMPLE_PRIORITIES); },
    getDeployRows: function () { ok(SAMPLE_DEPLOY); },
    updatePriorityStatus: function (repo, status, rowNumber) {
      var next = sanitizeStatus_(status);
      if (!next) { fail(new Error('Status is empty or not allowed.')); return; }
      var row = null;
      SAMPLE_PRIORITIES.rows.forEach(function (item) {
        if (item.rowNumber === Number(rowNumber) && item.repo === repo) row = item;
      });
      if (!row) { fail(new Error('No priority row matches that repository.')); return; }
      row.status = next;
      row.values[2] = next;
      ok({ ok: true, repo: repo, status: next, rowNumber: row.rowNumber });
    },
    getWebhookHealth: function () {
      ok({
        secretConfigured: true,
        tokenConfigured: false,
        geminiConfigured: true,
        autoClassify: false,
        editorsConfigured: false,
        editable: true,
        webAppUrl: 'https://script.google.com/macros/s/preview/exec',
        logSheet: 'Webhook Log',
        createdSheet: false,
        lastEvent: SAMPLE_EVENTS[0],
        events: SAMPLE_EVENTS,
        recentCounts: { ping: 1, workflow_run: 1, push: 1 },
        headerNote: 'Preview only. Apps Script web apps do not receive X-Hub-Signature-256; use ?token= on the /exec URL.'
      });
    },
    enrichInventoryRepo: function (repo) {
      var row = null;
      SAMPLE_ROWS.forEach(function (item) { if (item.repo === repo) row = item; });
      if (!row) { fail(new Error('No inventory row matches that repository.')); return; }
      row.stars = Number(row.stars || 0) + 1;
      ok({ ok: true, repo: repo, updated: ['stars'] });
    },
    getAiStatus: function () {
      ok({
        geminiConfigured: true,
        githubTokenConfigured: false,
        autoClassify: false,
        model: 'gemini-3.8-flash',
        editable: true
      });
    },
    classifyInventoryBatch: function (limit) {
      var partition = partitionUnclassified_(SAMPLE_ROWS, limit);
      if (!partition.ready.length) {
        ok({
          ok: true,
          classified: 0,
          limit: partition.limit,
          skipped: partition.skipped,
          error: '',
          message: partition.skipped
            ? 'Unclassified rows need an owner/repo name or a github.com URL before they can be classified.'
            : 'No unclassified repositories are waiting.',
          results: []
        });
        return;
      }
      var results = partition.ready.map(previewClassifyRow);
      var summary = summarizeClassify_(results, partition.limit);
      summary.skipped = partition.skipped;
      ok(summary);
    },
    classifySelectedRepos: function (repos) {
      var list = Array.isArray(repos) ? repos : [];
      if (!list.length) {
        ok({ ok: false, classified: 0, error: 'Select at least one repository.', results: [] });
        return;
      }
      var results = [];
      list.slice(0, clampBatchLimit_(list.length)).forEach(function (key) {
        var row = null;
        SAMPLE_ROWS.forEach(function (item) { if (item.repo === key) row = item; });
        if (!row) results.push({ ok: false, repo: key, error: 'No inventory row matches that repository.' });
        else results.push(previewClassifyRow(row));
      });
      ok(summarizeClassify_(results, clampBatchLimit_(list.length)));
    },
    classifyRepo: function (owner, name) {
      var key = owner && name ? owner + '/' + name : (name || owner || '');
      var row = null;
      SAMPLE_ROWS.forEach(function (item) { if (item.repo === key) row = item; });
      if (!row) { ok({ ok: false, repo: key, error: 'No inventory row matches that repository.' }); return; }
      ok(publicClassifyResult_(previewClassifyRow(row)));
    },
    getWebAppUrl: function () { ok('https://script.google.com/macros/s/preview/exec'); }
  };
  return runner;
}
window.google = window.google || {};
window.google.script = window.google.script || {};
Object.defineProperty(window.google.script, 'run', { configurable: true, get: function () { return makeRunner(); } });
`;

const html = page.replace('<!--PREVIEW-->', '<script>\n' + sources + '\n' + sample + '\n</script>');

const server = createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, '0.0.0.0', () => {
  console.log('GitHub Control Tower preview at http://127.0.0.1:' + port);
});

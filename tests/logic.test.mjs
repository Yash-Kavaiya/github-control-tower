import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function read(name) {
  return readFileSync(path.join(root, name), 'utf8');
}

const context = vm.createContext({ console: console });
vm.runInContext(
  [read('Main.gs'), read('Api.gs'), read('Webhook.gs')].join('\n'),
  context,
  { filename: 'apps-script.js' }
);

const api = context;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const HEADERS = [
  'Repo', 'URL', 'Description', 'Visibility', 'Stars', 'Fork?', 'Topics',
  'Has README', 'Has CI', 'Deploy status', 'Security alerts', 'Category',
  'Tech stack', 'Production relevance score', 'Priority', 'Future plan'
];

test('manifest is clasp-ready for Asia/Calcutta and anonymous webhooks', () => {
  const manifest = JSON.parse(read('appsscript.json'));
  assert.equal(manifest.timeZone, 'Asia/Calcutta');
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.equal(manifest.webapp.access, 'ANYONE_ANONYMOUS');
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.equal(api.CT.SPREADSHEET_ID, '1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w');
  assert.equal(api.CT.INVENTORY_HEADER_ROW, 4);
  assert.equal(api.CT.INVENTORY_DATA_START, 5);
});

test('html and gs files do not share a basename', () => {
  const counts = {};
  readdirSync(root).forEach((file) => {
    const match = file.match(/^(.*)\.(gs|html)$/);
    if (!match) return;
    counts[match[1]] = (counts[match[1]] || 0) + 1;
  });
  Object.keys(counts).forEach((name) => assert.equal(counts[name], 1, name));
  assert.match(read('Main.gs'), /createHtmlOutputFromFile\('Index'\)/);
  assert.match(read('Main.gs'), /createHtmlOutputFromFile\('Sidebar'\)/);
  assert.doesNotMatch(read('appsscript.json') + read('Main.gs') + read('Api.gs') + read('Webhook.gs'), /ghp_|github_pat_|GITHUB_WEBHOOK_SECRET['"]\s*:\s*['"][^'"]+/);
});

test('no duplicate function declarations', () => {
  const seen = {};
  ['Main.gs', 'Api.gs', 'Webhook.gs'].forEach((file) => {
    const re = /^function\s+([A-Za-z0-9_]+)\s*\(/gm;
    let match;
    const source = read(file);
    while ((match = re.exec(source))) {
      assert.equal(seen[match[1]], undefined, match[1] + ' duplicated in ' + file);
      seen[match[1]] = file;
    }
  });
  ['getOverviewMetrics', 'getInventoryRows', 'getPriorities', 'getDeployRows', 'updatePriorityStatus', 'getWebhookHealth', 'doGet', 'doPost', 'onOpen'].forEach((name) => {
    assert.ok(seen[name], name);
  });
});

test('inventory headers map onto the review board layout', () => {
  const map = api.mapHeaders_(HEADERS, api.INVENTORY_FIELDS);
  api.INVENTORY_FIELDS.forEach((field, index) => assert.equal(map[field.key], index, field.key));
  assert.equal(api.normalizeHeader_('Fork?'), 'fork?');
  assert.equal(api.normalizeHeader_('Production relevance score'), 'production relevance score');
});

test('inventory reader keeps sheet row numbers and skips blank repos', () => {
  const map = api.mapHeaders_(HEADERS, api.INVENTORY_FIELDS);
  const blank = HEADERS.map(() => '');
  const one = blank.slice();
  one[0] = 'sample-org/one';
  one[14] = 'P1';
  const gap = blank.slice();
  gap[2] = 'orphan description';
  const two = blank.slice();
  two[0] = 'sample-org/two';
  const rows = api.rowsFromInventoryValues_(map, [one, gap, two]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._rowNumber, 5);
  assert.equal(rows[1]._rowNumber, 7);
  assert.equal(rows[1].repo, 'sample-org/two');
});

test('overview metrics come from inventory fields', () => {
  const rows = [
    { repo: 'a', priority: 'P1', category: 'NVIDIA', stack: '', topics: '', description: '', deployStatus: 'Live', hasCi: 'Yes', score: 8 },
    { repo: 'b', priority: 'P2 - soon', category: 'Apps', stack: 'Google Cloud', topics: '', description: '', deployStatus: 'Failed', hasCi: 'No', score: 9 },
    { repo: 'c', priority: 'P3', category: 'Tools', stack: '', topics: 'gcp', description: '', deployStatus: 'Ready to deploy', hasCi: 'true', score: 'n/a' },
    { repo: 'd', priority: 'Later', category: 'NVIDIA', stack: 'BigQuery', topics: '', description: '', deployStatus: '', hasCi: '', score: '' }
  ];
  const overview = api.buildOverview_(rows);
  assert.equal(overview.total, 4);
  assert.equal(overview.p1, 1);
  assert.equal(overview.p2, 1);
  assert.equal(overview.p3, 1);
  assert.equal(overview.otherPriority, 1);
  assert.equal(overview.nvidia, 2);
  assert.equal(overview.gcp, 3);
  assert.equal(overview.deployed, 1);
  assert.equal(overview.ciYes, 2);
  assert.equal(overview.ciCoverage, 50);
  assert.equal(overview.avgScore, 8.5);
  assert.equal(overview.scoredCount, 2);
});

test('inventory filters use priority buckets, deploy status, category, CI, and search', () => {
  const rows = [
    { repo: 'alpha', priority: 'P1 now', deployStatus: 'Live', category: 'NVIDIA', hasCi: 'Yes', description: 'inference', topics: '', stack: '', plan: '', url: '', visibility: '' },
    { repo: 'beta', priority: 'P2', deployStatus: 'Failed', category: 'Tools', hasCi: 'No', description: '', topics: 'cloud run', stack: '', plan: '', url: '', visibility: '' }
  ];
  assert.equal(api.filterInventory_(rows, api.normalizeFilters_({ priority: 'p1' })).length, 1);
  assert.equal(api.filterInventory_(rows, api.normalizeFilters_({ deployStatus: 'Failed' }))[0].repo, 'beta');
  assert.equal(api.filterInventory_(rows, api.normalizeFilters_({ category: 'NVIDIA' }))[0].repo, 'alpha');
  assert.equal(api.filterInventory_(rows, api.normalizeFilters_({ hasCi: 'no' }))[0].repo, 'beta');
  assert.equal(api.filterInventory_(rows, api.normalizeFilters_({ query: 'CLOUD' }))[0].repo, 'beta');
  const options = api.inventoryOptions_(rows.concat([{ repo: 'z', priority: 'Later', deployStatus: '', category: '', hasCi: '' }]));
  assert.deepEqual(plain(options.priorities), ['P1', 'P2', 'P3', 'OTHER']);
});

test('github event inference and webhook body parsing', () => {
  assert.equal(api.inferGithubEvent_({ zen: 'keep', hook: { id: 1 }, repository: { name: 'x' } }, ''), 'ping');
  assert.equal(api.inferGithubEvent_({ workflow_run: {}, repository: {} }, ''), 'workflow_run');
  assert.equal(api.inferGithubEvent_({ ref: 'refs/heads/main', after: 'abc', pusher: {}, repository: {}, commits: [] }, ''), 'push');
  assert.equal(api.inferGithubEvent_({ action: 'deleted', starred_at: null, repository: {} }, ''), 'star');
  assert.equal(api.inferGithubEvent_({ action: 'edited', repository: { name: 'x' } }, ''), 'repository');
  assert.equal(api.inferGithubEvent_({}, 'Push'), 'push');
  assert.deepEqual(plain(api.parseWebhookBody_({ postData: { type: 'application/json', contents: '{"ok":true}' } })), { ok: true });
  assert.deepEqual(plain(api.parseWebhookBody_({ postData: { type: 'application/x-www-form-urlencoded', contents: 'payload=%7B%7D' }, parameter: { payload: '{"n":2}' } })), { n: 2 });
  assert.throws(() => api.parseWebhookBody_({ postData: { type: 'application/json', contents: '{' } }), /invalid_json/);
  assert.equal(api.readHeader_({ headers: { 'X-GitHub-Event': 'star' } }, 'X-GitHub-Event'), 'star');
  assert.equal(api.readHeader_({ parameter: {} }, 'X-Hub-Signature-256'), '');
});

test('webhook plans upsert fields without clobbering human deploy status', () => {
  const repository = {
    name: 'demo',
    full_name: 'sample-org/demo',
    html_url: 'https://github.com/sample-org/demo',
    description: 'A demo',
    visibility: 'public',
    stargazers_count: 3,
    fork: false,
    topics: []
  };
  const inserted = api.planInventoryUpdate_(null, 'push', { repository: repository });
  assert.equal(inserted.result, 'inserted');
  assert.equal(inserted.values.repo, 'sample-org/demo');
  assert.equal(inserted.values.stars, 3);
  assert.equal(inserted.values.fork, 'No');
  assert.equal(inserted.values.topics, undefined);

  const current = { repo: 'demo', deployStatus: 'Live', visibility: 'Public', fork: 'TRUE', hasCi: 'Yes', description: 'keep' };
  const updated = api.planInventoryUpdate_(current, 'push', { repository: repository });
  assert.equal(updated.result, 'updated');
  assert.equal(updated.values.repo, undefined);
  assert.equal(updated.values.visibility, 'Public');
  assert.equal(updated.values.fork, 'FALSE');

  const deploy = api.planInventoryUpdate_(current, 'workflow_run', {
    action: 'completed',
    workflow_run: { name: 'Deploy Production', conclusion: 'success' },
    repository: repository
  });
  assert.equal(deploy.values.hasCi, 'Yes');
  assert.equal(deploy.values.deployStatus, undefined);

  const replace = api.planInventoryUpdate_({ deployStatus: 'Deployed', hasCi: 'No' }, 'workflow_run', {
    workflow_run: { name: 'pages-build-deployment', conclusion: 'failure' },
    repository: repository
  });
  assert.equal(replace.values.deployStatus, 'Failed');
  assert.equal(replace.values.hasCi, 'Yes');

  const ciOnly = api.planInventoryUpdate_({ deployStatus: '', hasCi: '' }, 'workflow_run', {
    workflow_run: { name: 'CI', conclusion: 'success' },
    repository: repository
  });
  assert.equal(ciOnly.values.deployStatus, undefined);
  assert.equal(ciOnly.values.hasCi, 'Yes');

  const deleted = api.planInventoryUpdate_(current, 'repository', { action: 'deleted', repository: repository });
  assert.equal(deleted.result, 'noted');
  assert.deepEqual(plain(deleted.values), {});

  const renamed = api.planInventoryUpdate_(current, 'repository', {
    action: 'renamed',
    repository: { name: 'new', full_name: 'sample-org/new', visibility: 'private' },
    changes: { repository: { name: { from: 'demo' } } }
  });
  assert.equal(renamed.values.repo, 'sample-org/new');
  assert.equal(renamed.previousName, 'demo');
});

test('inventory matching is exact, then suffix, and refuses ambiguity', () => {
  const rows = [{ repo: 'sample-org/demo' }, { repo: 'other' }];
  assert.equal(api.findInventoryMatch_(rows, 'demo', 'sample-org/demo'), 0);
  assert.equal(api.findInventoryMatch_(rows, 'demo', ''), 0);
  assert.equal(api.findInventoryMatch_(rows, 'missing', 'nope'), -1);
  assert.equal(api.findInventoryMatch_([{ repo: 'a/demo' }, { repo: 'b/demo' }], 'demo', ''), -2);
});

test('signature check accepts signed bytes and the query token', () => {
  const secret = 'not-a-real-secret';
  const body = '{"zen":"keep it simple"}';
  const digest = createHmac('sha256', secret).update(body).digest();
  const signed = Array.from(digest, (byte) => (byte > 127 ? byte - 256 : byte));
  context.Utilities = {
    computeHmacSha256Signature: (payload, key) => {
      assert.equal(payload, body);
      assert.equal(key, secret);
      return signed;
    }
  };
  const signature = 'sha256=' + digest.toString('hex');
  assert.equal(api.verifyGithubSignature_(body, signature, secret), true);
  assert.equal(api.verifyGithubSignature_(body, signature.slice(0, -1) + '0', secret), false);
  assert.equal(api.verifyGithubSignature_(body, '', secret), false);
  assert.equal(api.secureCompare_(secret, secret), true);
  assert.equal(api.secureCompare_(secret, secret + 'x'), false);
  assert.equal(api.bytesToHex_([-1, 15]), 'ff0f');
  assert.equal(api.safeSheetValue_('=HYPERLINK("https://evil")'), "'=HYPERLINK(\"https://evil\")");
  assert.equal(api.safeSheetValue_(12), 12);
});

test('editors and status guards fail closed for anonymous callers', () => {
  assert.equal(api.mutationAllowed_('', 'owner@example.com', ''), false);
  assert.equal(api.mutationAllowed_('owner@example.com', 'owner@example.com', ''), true);
  assert.equal(api.mutationAllowed_('other@example.com', 'owner@example.com', ''), false);
  assert.equal(api.mutationAllowed_('other@example.com', 'owner@example.com', 'other@example.com, third@example.com'), true);
  assert.equal(api.sanitizeStatus_('In progress'), 'In progress');
  assert.equal(api.sanitizeStatus_('=IMPORTRANGE()'), '');
  assert.equal(api.sanitizeStatus_('-blocked'), '');
  assert.equal(api.sanitizeStatus_(''), '');
  assert.equal(api.sanitizeRepoKey_('sample-org/demo'), 'sample-org/demo');
  assert.deepEqual(plain(api.repoCoordinates_('demo', 'https://github.com/sample-org/demo')), { owner: 'sample-org', repo: 'demo' });
  assert.deepEqual(plain(api.repoCoordinates_('sample-org/demo.git', '')), { owner: 'sample-org', repo: 'demo' });
  assert.equal(api.repoCoordinates_('demo', ''), null);
});

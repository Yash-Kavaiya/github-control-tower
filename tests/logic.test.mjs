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
  [read('Main.gs'), read('Api.gs'), read('Webhook.gs'), read('Ai.gs')].join('\n'),
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
  assert.ok(manifest.urlFetchWhitelist.includes('https://api.github.com/'));
  assert.ok(manifest.urlFetchWhitelist.includes('https://generativelanguage.googleapis.com/'));
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
  const sources = ['appsscript.json', 'Main.gs', 'Api.gs', 'Webhook.gs', 'Ai.gs', 'Index.html', 'Sidebar.html', 'README.md'].map(read).join('\n');
  assert.doesNotMatch(sources, /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(sources, /GITHUB_WEBHOOK_SECRET['"]\s*:\s*['"][^'"]+/);
});

test('no duplicate function declarations', () => {
  const seen = {};
  ['Main.gs', 'Api.gs', 'Webhook.gs', 'Ai.gs'].forEach((file) => {
    const re = /^function\s+([A-Za-z0-9_]+)\s*\(/gm;
    let match;
    const source = read(file);
    while ((match = re.exec(source))) {
      assert.equal(seen[match[1]], undefined, match[1] + ' duplicated in ' + file);
      seen[match[1]] = file;
    }
  });
  ['getOverviewMetrics', 'getInventoryRows', 'getPriorities', 'getDeployRows', 'updatePriorityStatus', 'getWebhookHealth', 'doGet', 'doPost', 'onOpen', 'classifyRepo', 'classifyInventoryBatch', 'classifySelectedRepos', 'getAiStatus', 'listOwnerRepos'].forEach((name) => {
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

test('github headers send a bearer token only when one is configured', () => {
  const anonymous = api.githubHeaders_('');
  assert.equal(anonymous.Authorization, undefined);
  assert.equal(anonymous.Accept, 'application/vnd.github+json');
  assert.equal(api.githubHeaders_('placeholder').Authorization, 'Bearer placeholder');
  const limited = api.githubFailureMessage_(403, '{"message":"API rate limit exceeded"}', { 'X-RateLimit-Remaining': '0' }, false, '/repos/acme/demo');
  assert.match(limited, /Set GITHUB_TOKEN/);
  assert.doesNotMatch(limited, /Bearer|placeholder|ghp_/);
  const authed = api.githubFailureMessage_(429, '', {}, true, '/repos/acme/demo');
  assert.match(authed, /rate-limit window/i);
  assert.doesNotMatch(authed, /Set GITHUB_TOKEN/);
  assert.match(api.githubFailureMessage_(401, '', {}, true, '/repos/acme/demo'), /HTTP 401/);
  assert.match(api.githubFailureMessage_(404, '', {}, false, '/repos/acme/demo'), /private/);
});

test('gemini classification parses fenced json, synonyms, and api envelopes', () => {
  const fenced = [
    '```json',
    '{"priority":"high","tech_stack":"Python, FastAPI","deploy_status":"staging","rationale":"Demo service with a staging homepage.","tags":["ml","ML","=skip"]}',
    '```'
  ].join('\n');
  const parsed = api.parseGeminiClassification_(fenced);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.classification.priority, 'P1');
  assert.equal(parsed.classification.deploy_status, 'demo');
  assert.equal(parsed.classification.tech_stack, 'Python, FastAPI');
  assert.deepEqual(plain(parsed.classification.tags), ['ml']);

  assert.equal(api.normalizePriorityToken_('P2 - soon'), 'P2');
  assert.equal(api.normalizePriorityToken_('medium'), 'P2');
  assert.equal(api.normalizePriorityToken_('3'), 'P3');
  assert.equal(api.normalizePriorityToken_('later'), '');
  assert.equal(api.normalizeDeployHint_('in production'), 'live');
  assert.equal(api.normalizeDeployHint_('not deployed'), 'none');
  assert.equal(api.normalizeDeployHint_('preview site'), 'demo');

  const envelope = {
    candidates: [{
      content: {
        parts: [
          { thought: true, text: '{"priority":"P1"}' },
          { text: '{"priority":"P3","tech_stack":"Notes","deploy_status":"none","rationale":"Learning repo with no deploy signal.","tags":["learning"]}' }
        ]
      }
    }]
  };
  const fromApi = api.parseGeminiClassification_(envelope);
  assert.equal(fromApi.classification.priority, 'P3');
  assert.equal(fromApi.classification.deploy_status, 'none');
  assert.match(fromApi.classification.rationale, /Learning repo/);

  const wrapped = api.parseGeminiClassification_('note {"priority":"P2","tech_stack":"Go","deploy_status":"live","rationale":"Ships on Cloud Run."} trailing');
  assert.equal(wrapped.classification.priority, 'P2');
  assert.equal(wrapped.classification.deploy_status, 'live');

  assert.equal(api.parseGeminiClassification_('not json').ok, false);
  assert.equal(api.parseGeminiClassification_('{"priority":"P1","tech_stack":"Go","deploy_status":"live"}').ok, false);
  assert.match(api.parseGeminiClassification_('{"priority":"later","tech_stack":"Go","deploy_status":"live","rationale":"No."}').error, /P1, P2, or P3/);
});

test('classification writes priority and tech stack without clobbering a human deploy status', () => {
  const classification = {
    priority: 'P2',
    tech_stack: 'Go, Cloud Run',
    deploy_status: 'live',
    rationale: 'Ships on Cloud Run.',
    tags: ['gcp']
  };
  const kept = api.classificationSheetPatch_(classification, { deployStatus: 'Failed', description: 'keep me' });
  assert.equal(kept.priority, 'P2');
  assert.equal(kept.stack, 'Go, Cloud Run');
  assert.equal(kept.deployStatus, undefined);
  assert.equal(kept.description, undefined);

  const filled = api.classificationSheetPatch_(classification, { deployStatus: '' });
  assert.equal(filled.deployStatus, 'Live');
  const refreshHint = api.classificationSheetPatch_(
    Object.assign({}, classification, { deploy_status: 'none' }),
    { deployStatus: 'Demo' }
  );
  assert.equal(refreshHint.deployStatus, 'None');
  assert.equal(api.classificationSheetPatch_(classification, { deployStatus: 'Live' }).deployStatus, undefined);
});

test('batch selection, auto-classify gate, and gemini request omit secrets', () => {
  assert.equal(api.clampBatchLimit_(undefined), 5);
  assert.equal(api.clampBatchLimit_(0), 5);
  assert.equal(api.clampBatchLimit_('3'), 3);
  assert.equal(api.clampBatchLimit_(40), 8);
  assert.equal(api.isAutoClassifyEnabled_(''), false);
  assert.equal(api.isAutoClassifyEnabled_('true'), true);
  assert.equal(api.isAutoClassifyEnabled_('YES'), true);
  assert.equal(api.isUnclassifiedPriority_(''), true);
  assert.equal(api.isUnclassifiedPriority_('Later'), true);
  assert.equal(api.isUnclassifiedPriority_('P1 this week'), false);

  const rows = [
    { repo: 'acme/one', url: '', priority: '', deployStatus: '' },
    { repo: 'two', url: '', priority: 'Later', deployStatus: '' },
    { repo: 'acme/three', url: 'https://github.com/acme/three', priority: 'P1', deployStatus: 'Live' },
    { repo: 'acme/four', url: 'https://github.com/acme/four', priority: '', deployStatus: 'Demo' }
  ];
  const part = api.partitionUnclassified_(rows, 1);
  assert.equal(part.limit, 1);
  assert.equal(part.ready.length, 1);
  assert.equal(part.ready[0].repo, 'acme/one');
  assert.equal(part.skipped, 1);

  const repoContext = api.buildRepoClassifyContext_({
    name: 'one',
    full_name: 'acme/one',
    description: 'Status board',
    language: 'JavaScript',
    topics: ['sheets'],
    homepage: 'https://example.com',
    stargazers_count: 2
  }, { JavaScript: 10, HTML: 2 }, 'Hello readme');
  assert.equal(repoContext.language, 'JavaScript');
  assert.deepEqual(plain(repoContext.languages), ['JavaScript', 'HTML']);
  assert.equal(repoContext.homepage, 'https://example.com');
  assert.match(api.buildClassifyPrompt_(repoContext), /Status board/);
  const body = api.buildGeminiRequestBody_(repoContext);
  assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(JSON.stringify(body).includes('AIza'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'apiKey'), false);

  const marker = ['A', 'I', 'z', 'a', 'Sy', 'NotARealKey000000'].join('');
  const cleaned = api.geminiHttpError_(500, JSON.stringify({ error: { message: 'bad ' + marker } }));
  assert.equal(cleaned.includes(marker), false);
  assert.match(cleaned, /\[redacted\]/);
  assert.match(api.geminiHttpError_(400, '{"error":{"message":"API key not valid"}}'), /GEMINI_API_KEY/);
  assert.match(api.geminiHttpError_(404, '{}'), /gemini-3\.8-flash/);
  assert.equal(api.geminiModel_(), 'gemini-3.8-flash');

  const push = { ref: 'refs/heads/main', repository: { default_branch: 'main' } };
  assert.equal(api.shouldAutoClassifyEvent_('push', push, true, '', 'true'), true);
  assert.equal(api.shouldAutoClassifyEvent_('push', { ref: 'refs/heads/feature', repository: { default_branch: 'main' } }, true, '', 'true'), false);
  assert.equal(api.shouldAutoClassifyEvent_('repository', { action: 'created', repository: {} }, true, '', ''), false);
  assert.equal(api.shouldAutoClassifyEvent_('repository', { action: 'deleted', repository: {} }, true, '', 'yes'), false);
  assert.equal(api.shouldAutoClassifyEvent_('star', { repository: {} }, true, '', 'true'), false);
  assert.equal(api.shouldAutoClassifyEvent_('push', push, false, 'P1', 'true'), false);
  assert.equal(api.shouldAutoClassifyEvent_('repository', { action: 'created', repository: {} }, false, '', 'true'), true);
  assert.equal(api.isSignificantPush_({ ref: 'refs/heads/master', repository: {} }), true);

  context.Utilities = context.Utilities || {};
  context.Utilities.base64Decode = (value) => Array.from(Buffer.from(value, 'base64'));
  context.Utilities.newBlob = (bytes) => ({
    getDataAsString: () => Buffer.from(bytes.map((byte) => (byte < 0 ? byte + 256 : byte))).toString('utf8')
  });
  assert.equal(api.decodeGithubBase64_(Buffer.from('Hello readme', 'utf8').toString('base64')), 'Hello readme');
  assert.equal(api.clipReadmeSnippet_('x'.repeat(20), 8).endsWith('…'), true);
  assert.equal(api.summarizeGithubRepos_([{ full_name: 'acme/one', description: 'A', private: false, language: 'Go', html_url: 'https://github.com/acme/one', stargazers_count: 1, topics: ['a'] }])[0].full_name, 'acme/one');
});

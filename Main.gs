/**
 * GitHub Control Tower v1
 *
 * Bound to Yash GitHub Review Board.
 * Script properties (Project settings → Script properties):
 *   GITHUB_WEBHOOK_SECRET   required for doPost
 *   GITHUB_TOKEN            optional; enrichInventoryRepo reads GitHub
 *   CONTROL_TOWER_EDITORS   optional comma-separated emails allowed to edit
 *
 * Anonymous web-app callers can read the dashboard and POST webhooks.
 * They cannot change priority status or call GitHub enrich.
 */

var CT = {
  SPREADSHEET_ID: '1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w',
  INVENTORY_SHEET: 'Full Inventory',
  PRIORITIES_SHEET: 'Today & Priorities',
  DEPLOY_SHEET: 'Deploy Tracker',
  WEBHOOK_SHEET: 'Webhook Log',
  INVENTORY_HEADER_ROW: 4,
  INVENTORY_DATA_START: 5,
  TIMEZONE: 'Asia/Calcutta',
  CACHE_TTL: 180,
  LOG_LIMIT: 40
};

var INVENTORY_FIELDS = [
  { key: 'repo', labels: ['repo', 'repository', 'name'] },
  { key: 'url', labels: ['url', 'html url', 'link'] },
  { key: 'description', labels: ['description', 'desc'] },
  { key: 'visibility', labels: ['visibility'] },
  { key: 'stars', labels: ['stars', 'stargazers'] },
  { key: 'fork', labels: ['fork', 'fork?'] },
  { key: 'topics', labels: ['topics', 'topic'] },
  { key: 'hasReadme', labels: ['has readme', 'readme'] },
  { key: 'hasCi', labels: ['has ci', 'ci'] },
  { key: 'deployStatus', labels: ['deploy status', 'deployment status', 'deploy'] },
  { key: 'security', labels: ['security alerts', 'security'] },
  { key: 'category', labels: ['category'] },
  { key: 'stack', labels: ['tech stack', 'stack'] },
  { key: 'score', labels: ['production relevance score', 'relevance score', 'score'] },
  { key: 'priority', labels: ['priority'] },
  { key: 'plan', labels: ['future plan', 'plan'] }
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Control Tower')
    .addItem('Open dashboard', 'showDashboard')
    .addItem('Web app URL', 'showWebAppUrl')
    .addToUi();
}

function showDashboard() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Control Tower');
  SpreadsheetApp.getUi().showSidebar(html);
}

function showWebAppUrl() {
  var url = getWebAppUrl();
  var body = '<div style="font-family:Roboto,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1b1b1b">' +
    '<p>Deploy a web app from this project: <b>Execute as me</b>, <b>Who has access: Anyone</b>. GitHub cannot sign in, so “Anyone with a Google account” rejects webhook posts.</p>' +
    '<p><b>Web app URL</b><br>' +
    (url ? '<a href="' + escapeHtml_(url) + '" target="_blank" rel="noopener">' + escapeHtml_(url) + '</a>' : 'Not deployed yet. Use Deploy → New deployment → Web app, then reopen this dialog.') +
    '</p>' +
    '<p>Webhook payload URL: the <code>/exec</code> address plus <code>?token=</code> set to script property <code>GITHUB_WEBHOOK_SECRET</code>. Use the <code>/exec</code> URL, not <code>/dev</code>.</p>' +
    '</div>';
  var html = HtmlService.createHtmlOutput(body).setWidth(460).setHeight(280);
  SpreadsheetApp.getUi().showModalDialog(html, 'Control Tower web app');
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('GitHub Control Tower')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var started = Date.now();
  var secret = getScriptProperty_('GITHUB_WEBHOOK_SECRET');
  var token = '';
  if (e && e.parameter) token = e.parameter.token || e.parameter.secret || '';
  var raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '';
  var signature = readHeader_(e, 'X-Hub-Signature-256');

  if (!secret) {
    return jsonOut_({ ok: false, error: 'webhook_secret_not_configured' });
  }
  var signed = signature ? verifyGithubSignature_(raw, signature, secret) : false;
  var tokenOk = token ? secureCompare_(String(token), secret) : false;
  if (!signed && !tokenOk) {
    return jsonOut_({ ok: false, error: 'unauthorized' });
  }

  var locked = false;
  var lock = LockService.getScriptLock();
  try {
    locked = lock.tryLock(8000);
    if (!locked) return jsonOut_({ ok: false, error: 'busy' });

    var payload = parseWebhookBody_(e);
    var eventName = inferGithubEvent_(payload, readHeader_(e, 'X-GitHub-Event'));
    var accepted = { push: 1, repository: 1, workflow_run: 1, star: 1, ping: 1 };
    var outcome;
    if (!accepted[eventName]) {
      outcome = {
        action: '',
        result: 'ignored',
        repo: payload && payload.repository ? (payload.repository.full_name || payload.repository.name || '') : '',
        detail: 'unsupported event'
      };
    } else if (eventName === 'ping') {
      outcome = { action: 'ping', result: 'pong', repo: '', detail: '' };
    } else {
      outcome = applyGithubWebhook_(eventName, payload);
    }
    appendWebhookLog_(eventName, outcome.repo, outcome.action, outcome.result, outcome.detail || '');
    if (outcome.result === 'updated' || outcome.result === 'inserted') invalidateCache_();
    return jsonOut_({
      ok: true,
      event: eventName,
      result: outcome.result,
      repo: outcome.repo || '',
      ms: Date.now() - started
    });
  } catch (err) {
    var message = String(err && err.message ? err.message : err).slice(0, 300);
    try {
      appendWebhookLog_('error', '', '', 'error', message);
    } catch (ignore) {}
    return jsonOut_({ ok: false, error: 'processing_failed' });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function getWebAppUrl() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

function getSpreadsheet_() {
  var active = null;
  try {
    active = SpreadsheetApp.getActive();
  } catch (err) {
    active = null;
  }
  if (active) return active;
  return SpreadsheetApp.openById(CT.SPREADSHEET_ID);
}

function getScriptProperty_(name) {
  try {
    return PropertiesService.getScriptProperties().getProperty(name) || '';
  } catch (err) {
    return '';
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readHeader_(e, name) {
  if (!e) return '';
  var target = String(name || '').toLowerCase();
  var bags = [e.headers, e.Headers];
  var i;
  for (i = 0; i < bags.length; i++) {
    var bag = bags[i];
    if (!bag) continue;
    var keys = Object.keys(bag);
    var k;
    for (k = 0; k < keys.length; k++) {
      if (String(keys[k]).toLowerCase() === target) return String(bag[keys[k]] || '');
    }
  }
  if (e.parameter && e.parameter[name]) return String(e.parameter[name]);
  return '';
}

function normalizeHeader_(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9? ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapHeaders_(headerRow, fields) {
  var normalized = (headerRow || []).map(normalizeHeader_);
  var map = {};
  (fields || []).forEach(function (field) {
    var idx = -1;
    var i;
    for (i = 0; i < field.labels.length; i++) {
      idx = normalized.indexOf(normalizeHeader_(field.labels[i]));
      if (idx >= 0) break;
    }
    map[field.key] = idx;
  });
  return map;
}

function mutationAllowed_(activeEmail, effectiveEmail, editorsProp) {
  var active = String(activeEmail || '').trim().toLowerCase();
  if (!active) return false;
  var allow = String(editorsProp || '')
    .split(',')
    .map(function (part) { return part.trim().toLowerCase(); })
    .filter(Boolean);
  if (allow.length) return allow.indexOf(active) !== -1;
  var owner = String(effectiveEmail || '').trim().toLowerCase();
  return !!owner && active === owner;
}

function canMutate_() {
  var active = '';
  var effective = '';
  try { active = Session.getActiveUser().getEmail() || ''; } catch (err) { active = ''; }
  try { effective = Session.getEffectiveUser().getEmail() || ''; } catch (err2) { effective = ''; }
  return mutationAllowed_(active, effective, getScriptProperty_('CONTROL_TOWER_EDITORS'));
}

function requireEditor_() {
  if (!canMutate_()) {
    throw new Error('Sign in as the spreadsheet owner (or an address in CONTROL_TOWER_EDITORS) to edit. Anonymous web-app visitors can view only.');
  }
}

function cacheGetJson_(key) {
  try {
    var raw = CacheService.getScriptCache().get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function cachePutJson_(key, obj) {
  try {
    var text = JSON.stringify(obj);
    if (text.length > 90000) return false;
    CacheService.getScriptCache().put(key, text, CT.CACHE_TTL);
    return true;
  } catch (err) {
    return false;
  }
}

function invalidateCache_() {
  try {
    var cache = CacheService.getScriptCache();
    var meta = cacheGetJson_('ct:inv:meta');
    var count = meta && meta.n ? Number(meta.n) : 16;
    if (!count || count < 1) count = 1;
    if (count > 24) count = 24;
    var keys = ['ct:overview', 'ct:inv:meta'];
    var i;
    for (i = 0; i < count; i++) keys.push('ct:inv:' + i);
    cache.removeAll(keys);
  } catch (err) {}
}

function formatNow_() {
  return Utilities.formatDate(new Date(), CT.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function sanitizeRepoKey_(repo) {
  var text = String(repo == null ? '' : repo).trim();
  if (!text || text.length > 200) return '';
  if (/^[=+\-@]/.test(text)) return '';
  return text;
}

function sanitizeStatus_(status) {
  var text = String(status == null ? '' : status).trim();
  if (!text || text.length > 60) return '';
  if (/^[=+\-@]/.test(text)) return '';
  if (/[\r\n\t]/.test(text)) return '';
  return text;
}

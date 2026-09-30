/**
 * GitHub webhook upserts for Full Inventory, plus the Webhook Log sheet.
 * Prefer application/json. Authorize with ?token= matching GITHUB_WEBHOOK_SECRET.
 * X-Hub-Signature-256 is verified when the header is actually visible to Apps Script.
 */

var WEBHOOK_LOG_FIELDS = [
  { key: 'timestamp', labels: ['timestamp', 'time', 'date'] },
  { key: 'event', labels: ['event'] },
  { key: 'repo', labels: ['repo', 'repository'] },
  { key: 'action', labels: ['action'] },
  { key: 'result', labels: ['result'] },
  { key: 'detail', labels: ['detail', 'message', 'notes'] }
];

function parseWebhookBody_(e) {
  var raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '';
  var type = e && e.postData && e.postData.type ? String(e.postData.type) : '';
  var text = raw;
  if (e && e.parameter && e.parameter.payload && type.indexOf('json') === -1) {
    text = String(e.parameter.payload);
  }
  if (!text) return {};
  try {
    var parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    throw new Error('invalid_json');
  }
}

function inferGithubEvent_(payload, headerEvent) {
  if (headerEvent) return String(headerEvent).trim().toLowerCase();
  if (!payload || typeof payload !== 'object') return 'unknown';
  if (payload.zen && payload.hook) return 'ping';
  if (payload.workflow_run) return 'workflow_run';
  if (payload.commits || payload.head_commit || (payload.ref && payload.after && payload.repository && payload.pusher)) return 'push';
  if (Object.prototype.hasOwnProperty.call(payload, 'starred_at')) return 'star';
  if (payload.repository && payload.action) return 'repository';
  return 'unknown';
}

function planInventoryUpdate_(current, eventName, payload) {
  var repository = payload && payload.repository ? payload.repository : null;
  var repo = repository && repository.name ? String(repository.name) : '';
  var fullName = repository && repository.full_name ? String(repository.full_name) : repo;
  var action = payload && payload.action ? String(payload.action) : eventName;
  var previousName = '';
  if (eventName === 'repository' && payload.changes && payload.changes.repository && payload.changes.repository.name) {
    previousName = payload.changes.repository.name.from || '';
  }
  if (!repository || !repo) {
    return { action: action, result: 'skipped', repo: '', fullName: '', previousName: '', values: {}, detail: 'no repository' };
  }
  if (eventName === 'repository' && action === 'deleted') {
    return { action: action, result: 'noted', repo: fullName, fullName: fullName, previousName: previousName, values: {}, detail: 'repository deleted; inventory row kept' };
  }

  var values = {};
  if (repository.html_url) values.url = String(repository.html_url);
  if (typeof repository.description === 'string') values.description = repository.description;
  if (repository.visibility) values.visibility = String(repository.visibility);
  else if (typeof repository.private === 'boolean') values.visibility = repository.private ? 'private' : 'public';
  if (typeof repository.stargazers_count === 'number') values.stars = repository.stargazers_count;
  if (typeof repository.fork === 'boolean') values.fork = repository.fork ? 'Yes' : 'No';
  if (Array.isArray(repository.topics) && repository.topics.length) values.topics = repository.topics.join(', ');
  if (eventName === 'workflow_run') {
    values.hasCi = 'Yes';
    var hint = deployHintFromWorkflow_(payload.workflow_run);
    if (hint && (!current || shouldReplaceDeployStatus_(current.deployStatus))) values.deployStatus = hint;
  }
  if (!current || previousName) values.repo = fullName || repo;

  if (current) {
    values = stylePlannedValues_(values, current);
    return {
      action: action,
      result: 'updated',
      repo: fullName || repo,
      fullName: fullName,
      previousName: previousName,
      values: values,
      detail: previousName ? 'renamed from ' + previousName : ''
    };
  }
  return {
    action: action,
    result: 'inserted',
    repo: fullName || repo,
    fullName: fullName,
    previousName: previousName,
    values: stylePlannedValues_(values, {}),
    detail: 'new inventory row'
  };
}

function stylePlannedValues_(values, current) {
  var next = {};
  var keys = Object.keys(values || {});
  keys.forEach(function (key) {
    var value = values[key];
    if (value == null || value === '') return;
    if (key === 'visibility') next.visibility = formatVisibility_(value, current.visibility);
    else if (key === 'fork') next.fork = restyleYesNo_(value, current.fork);
    else if (key === 'hasCi') next.hasCi = restyleYesNo_(value, current.hasCi);
    else next[key] = value;
  });
  return next;
}

function formatVisibility_(visibility, sample) {
  var v = String(visibility || '').toLowerCase();
  var s = String(sample || '').trim();
  if (!v) return v;
  if (s && s === s.toUpperCase() && /[A-Z]/.test(s)) return v.toUpperCase();
  if (s && s.charAt(0) === s.charAt(0).toUpperCase() && s.charAt(0) !== s.charAt(0).toLowerCase()) {
    return v.charAt(0).toUpperCase() + v.slice(1);
  }
  return v;
}

function formatYesNo_(flag, sample) {
  return restyleYesNo_(flag ? 'Yes' : 'No', sample);
}

function restyleYesNo_(value, sample) {
  var yes = isYes_(value);
  var s = String(sample || '');
  if (s === 'TRUE' || s === 'FALSE') return yes ? 'TRUE' : 'FALSE';
  if (s === 'true' || s === 'false') return yes ? 'true' : 'false';
  if (s === 'Y' || s === 'N') return yes ? 'Y' : 'N';
  return yes ? 'Yes' : 'No';
}

function deployHintFromWorkflow_(workflowRun) {
  if (!workflowRun) return '';
  var name = String(workflowRun.name || workflowRun.path || '');
  if (!/deploy|release|pages|production|publish/i.test(name)) return '';
  var conclusion = String(workflowRun.conclusion || '').toLowerCase();
  if (conclusion === 'success') return 'Deployed';
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') return 'Failed';
  return '';
}

function shouldReplaceDeployStatus_(current) {
  var cur = String(current || '').trim().toLowerCase();
  if (!cur) return true;
  return cur === 'deployed' || cur === 'failed' || cur === 'deployed (webhook)' || cur === 'failed (webhook)';
}

function findInventoryMatch_(rows, repoName, fullName) {
  var exactFull = [];
  var exactName = [];
  var suffix = [];
  var shortName = String(repoName || '').toLowerCase();
  var full = String(fullName || '').toLowerCase();
  (rows || []).forEach(function (row, index) {
    var cell = String(row.repo || '').trim().toLowerCase();
    if (!cell) return;
    if (full && cell === full) exactFull.push(index);
    else if (shortName && cell === shortName) exactName.push(index);
    else if (shortName && cell.endsWith('/' + shortName)) suffix.push(index);
  });
  if (exactFull.length === 1) return exactFull[0];
  if (exactFull.length > 1) return -2;
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) return -2;
  if (suffix.length === 1) return suffix[0];
  if (suffix.length > 1) return -2;
  return -1;
}

function verifyGithubSignature_(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  var digestBytes = Utilities.computeHmacSha256Signature(String(rawBody), String(secret));
  var expected = 'sha256=' + bytesToHex_(digestBytes);
  return secureCompare_(expected, String(signatureHeader).trim());
}

function bytesToHex_(bytes) {
  var hex = '';
  var i;
  for (i = 0; i < bytes.length; i++) {
    var v = bytes[i];
    if (v < 0) v += 256;
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex;
}

function secureCompare_(left, right) {
  var a = String(left);
  var b = String(right);
  var len = Math.max(a.length, b.length);
  var diff = a.length === b.length ? 0 : 1;
  var i;
  for (i = 0; i < len; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function applyGithubWebhook_(eventName, payload) {
  var repository = payload && payload.repository ? payload.repository : {};
  var repoName = repository.name || '';
  var fullName = repository.full_name || repoName;
  var previousName = '';
  if (payload && payload.changes && payload.changes.repository && payload.changes.repository.name) {
    previousName = payload.changes.repository.name.from || '';
  }
  var loaded = readInventoryFromSheet_();
  var match = -1;
  if (previousName) match = findInventoryMatch_(loaded.rows, previousName, '');
  if (match < 0) match = findInventoryMatch_(loaded.rows, repoName, fullName);
  if (match === -2) {
    return { action: payload.action || eventName, result: 'ambiguous', repo: fullName, detail: 'multiple inventory rows match' };
  }
  var current = match >= 0 ? loaded.rows[match] : null;
  var plan = planInventoryUpdate_(current, eventName, payload);
  if (plan.result === 'updated' && match >= 0) {
    writeInventoryValues_(loaded.sheet, loaded.headerMap, loaded.colCount, loaded.rows[match]._rowNumber, plan.values);
  } else if (plan.result === 'inserted') {
    appendInventoryRow_(loaded.sheet, loaded.headerMap, loaded.colCount, plan.values);
  }
  return plan;
}

function safeSheetValue_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  var text = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) return "'" + text;
  return text;
}

function writeInventoryValues_(sheet, headerMap, colCount, rowNumber, values) {
  if (!rowNumber || rowNumber < CT.INVENTORY_DATA_START) return;
  var existing = sheet.getRange(rowNumber, 1, 1, colCount).getValues()[0];
  Object.keys(values || {}).forEach(function (key) {
    var idx = headerMap[key];
    if (idx == null || idx < 0 || idx >= colCount) return;
    existing[idx] = safeSheetValue_(values[key]);
  });
  sheet.getRange(rowNumber, 1, 1, colCount).setValues([existing]);
}

function appendInventoryRow_(sheet, headerMap, colCount, values) {
  var row = [];
  var i;
  for (i = 0; i < colCount; i++) row.push('');
  Object.keys(values || {}).forEach(function (key) {
    var idx = headerMap[key];
    if (idx == null || idx < 0 || idx >= colCount) return;
    row[idx] = safeSheetValue_(values[key]);
  });
  var dest = Math.max(sheet.getLastRow() + 1, CT.INVENTORY_DATA_START);
  sheet.getRange(dest, 1, 1, colCount).setValues([row]);
}

function createWebhookLogSheet_(ss) {
  var sheet = ss.insertSheet(CT.WEBHOOK_SHEET);
  sheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Event', 'Repo', 'Action', 'Result', 'Detail']]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(6, 320);
  return sheet;
}

function appendWebhookLog_(eventName, repo, action, result, detail) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CT.WEBHOOK_SHEET);
  if (!sheet) sheet = createWebhookLogSheet_(ss);
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 6)).getValues()[0];
  var map = mapHeaders_(headers, WEBHOOK_LOG_FIELDS);
  if (map.timestamp < 0 && String(headers[0] || '').trim() === '') {
    sheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Event', 'Repo', 'Action', 'Result', 'Detail']]);
    map = mapHeaders_(['Timestamp', 'Event', 'Repo', 'Action', 'Result', 'Detail'], WEBHOOK_LOG_FIELDS);
  }
  var width = Math.max(sheet.getLastColumn(), 6);
  var row = [];
  var i;
  for (i = 0; i < width; i++) row.push('');
  var record = {
    timestamp: formatNow_(),
    event: safeSheetValue_(eventName || ''),
    repo: safeSheetValue_(repo || ''),
    action: safeSheetValue_(action || ''),
    result: safeSheetValue_(result || ''),
    detail: safeSheetValue_(String(detail || '').slice(0, 500))
  };
  Object.keys(record).forEach(function (key) {
    var idx = map[key];
    if (idx == null || idx < 0) return;
    row[idx] = record[key];
  });
  sheet.appendRow(row.slice(0, width));
}

function readWebhookEntries_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), 6);
  if (lastRow < 1) return [];
  var headerValues = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = mapHeaders_(headerValues, WEBHOOK_LOG_FIELDS);
  if (lastRow < 2) return [];
  var start = Math.max(2, lastRow - CT.LOG_LIMIT + 1);
  var values = sheet.getRange(start, 1, lastRow - start + 1, lastCol).getValues();
  var entries = [];
  var i;
  for (i = values.length - 1; i >= 0; i--) {
    var raw = values[i];
    var entry = {
      timestamp: mappedLogCell_(raw, map.timestamp),
      event: mappedLogCell_(raw, map.event),
      repo: mappedLogCell_(raw, map.repo),
      action: mappedLogCell_(raw, map.action),
      result: mappedLogCell_(raw, map.result),
      detail: mappedLogCell_(raw, map.detail)
    };
    if (entry.timestamp || entry.event || entry.repo || entry.result) entries.push(entry);
  }
  return entries;
}

function mappedLogCell_(row, index) {
  if (index == null || index < 0 || index >= row.length) return '';
  return String(cellToPrimitive_(row[index]) || '');
}

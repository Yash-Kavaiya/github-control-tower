function doPost(e) {
  var result = { ok: false };
  try {
    result = handleWebhook_(e);
  } catch (err) {
    result = { ok: false, error: String(err && err.message || err) };
    try { appendWebhookLog_('error', '', '', result.error); } catch (e2) {}
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleWebhook_(e) {
  var secret = getProp_('GITHUB_WEBHOOK_SECRET');
  if (!secret) return { ok: false, error: 'GITHUB_WEBHOOK_SECRET not set' };

  var token = (e && e.parameter && e.parameter.token) || '';
  var headers = (e && e.headers) || {};
  var sig = headers['X-Hub-Signature-256'] || headers['x-hub-signature-256'] || '';
  var raw = (e && e.postData && e.postData.contents) || '';

  var authorized = false;
  if (token && token === secret) authorized = true;
  if (sig && raw && verifyGithubSignature_(raw, sig, secret)) authorized = true;
  if (!authorized) return { ok: false, error: 'unauthorized' };

  var event = headers['X-GitHub-Event'] || headers['x-github-event'] || 'unknown';
  var payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (err) { return { ok: false, error: 'invalid json' }; }

  if (event === 'ping') {
    appendWebhookLog_(event, '', 'ping', 'ok');
    return { ok: true, event: 'ping' };
  }

  var repoName = '';
  var repo = payload.repository || {};
  repoName = repo.name || (payload.workflow_run && payload.workflow_run.repository && payload.workflow_run.repository.name) || '';
  var action = payload.action || '';
  var upsert = upsertInventoryFromPayload_(event, payload, repo);
  appendWebhookLog_(event, repoName, action || event, upsert.result);
  return { ok: true, event: event, repo: repoName, upsert: upsert };
}

function verifyGithubSignature_(raw, signatureHeader, secret) {
  // Apps Script often strips this header; keep for when present.
  if (!signatureHeader || signatureHeader.indexOf('sha256=') !== 0) return false;
  var expected = 'sha256=' + bytesToHex_(Utilities.computeHmacSha256Signature(raw, secret));
  return expected === signatureHeader;
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function upsertInventoryFromPayload_(event, payload, repo) {
  if (!repo || !repo.name) return { result: 'no-repo' };
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(INVENTORY_SHEET);
  if (!sh) return { result: 'no-inventory-sheet' };
  var headers = inventoryHeaders_(sh);
  var repoCol = colIndex_(headers, 'Repo');
  if (repoCol < 0) return { result: 'no-repo-col' };

  var last = sh.getLastRow();
  var rowIndex = -1;
  if (last >= INVENTORY_DATA_START) {
    var names = sh.getRange(INVENTORY_DATA_START, repoCol + 1, last - INVENTORY_HEADER_ROW, 1).getDisplayValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0]) === String(repo.name)) { rowIndex = INVENTORY_DATA_START + i; break; }
    }
  }

  function setField(row, header, value) {
    var c = colIndex_(headers, header);
    if (c >= 0 && value !== undefined && value !== null && value !== '') {
      sh.getRange(row, c + 1).setValue(value);
    }
  }

  if (rowIndex < 0) {
    // append new
    var blank = headers.map(function () { return ''; });
    blank[repoCol] = repo.name;
    sh.appendRow(blank);
    rowIndex = sh.getLastRow();
  }

  setField(rowIndex, 'URL', repo.html_url || ('https://github.com/' + (repo.full_name || repo.name)));
  setField(rowIndex, 'Description', repo.description || '');
  setField(rowIndex, 'Visibility', repo.private ? 'private' : 'public');
  if (typeof repo.stargazers_count === 'number') setField(rowIndex, 'Stars', repo.stargazers_count);
  setField(rowIndex, 'Fork?', repo.fork ? 'Yes' : 'No');
  if (repo.topics && repo.topics.length) setField(rowIndex, 'Topics', repo.topics.join(', '));

  if (event === 'workflow_run' && payload.workflow_run) {
    var wr = payload.workflow_run;
    setField(rowIndex, 'Has CI', 'Yes');
    if (wr.conclusion === 'success') setField(rowIndex, 'Deploy status', 'CI green');
    else if (wr.conclusion === 'failure') setField(rowIndex, 'Deploy status', 'CI failure');
  }

  if (event === 'star' && typeof repo.stargazers_count === 'number') {
    setField(rowIndex, 'Stars', repo.stargazers_count);
  }

  return { result: 'upserted', row: rowIndex, repo: repo.name };
}

function appendWebhookLog_(event, repo, action, result) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(WEBHOOK_LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(WEBHOOK_LOG_SHEET);
    sh.appendRow(['Timestamp', 'Event', 'Repo', 'Action', 'Result']);
  }
  if (sh.getLastRow() === 0) sh.appendRow(['Timestamp', 'Event', 'Repo', 'Action', 'Result']);
  sh.appendRow([new Date(), event, repo, action, result]);
}

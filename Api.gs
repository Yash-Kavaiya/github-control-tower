function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function canEdit_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  if (!email) return false;
  var owners = (getProp_('CONTROL_TOWER_EDITORS') || '').split(/[\s,]+/).filter(Boolean);
  if (!owners.length) return true; // owner-only deploy; allow signed-in sheet users by default
  return owners.indexOf(email) !== -1;
}

function inventoryHeaders_(sheet) {
  return sheet.getRange(INVENTORY_HEADER_ROW, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
}

function colIndex_(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === name) return i;
  }
  return -1;
}

function readInventoryRows_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(INVENTORY_SHEET);
  if (!sh) return { headers: [], rows: [] };
  var headers = inventoryHeaders_(sh);
  var last = sh.getLastRow();
  if (last < INVENTORY_DATA_START) return { headers: headers, rows: [] };
  var values = sh.getRange(INVENTORY_DATA_START, 1, last - INVENTORY_HEADER_ROW, headers.length).getDisplayValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var obj = { _row: INVENTORY_DATA_START + i };
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[i][c];
    if (obj.Repo) rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

function getOverviewMetrics() {
  var data = readInventoryRows_();
  var rows = data.rows;
  var p1 = 0, p2 = 0, p3 = 0, nvidia = 0, gcp = 0, deployed = 0, withCi = 0, scoreSum = 0, scoreN = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var pri = String(r.Priority || '').toUpperCase();
    if (pri === 'P1') p1++; else if (pri === 'P2') p2++; else if (pri === 'P3') p3++;
    var cat = String(r.Category || '') + ' ' + String(r.Topics || '') + ' ' + String(r['Tech stack'] || '');
    if (/nvidia/i.test(cat)) nvidia++;
    if (/gcp|google cloud|cloud run|dialogflow|ccai|vertex/i.test(cat)) gcp++;
    var dep = String(r['Deploy status'] || '').toLowerCase();
    if (dep.indexOf('deploy') !== -1 && dep.indexOf('not') === -1) deployed++;
    if (/^yes/i.test(String(r['Has CI'] || ''))) withCi++;
    var sc = parseFloat(r['Production relevance score']);
    if (!isNaN(sc)) { scoreSum += sc; scoreN++; }
  }
  return {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    p1: p1, p2: p2, p3: p3,
    nvidia: nvidia, gcp: gcp,
    deployed: deployed,
    withCi: withCi,
    avgScore: scoreN ? Math.round((scoreSum / scoreN) * 10) / 10 : 0,
    canEdit: canEdit_()
  };
}

function getInventoryRows(filters) {
  filters = filters || {};
  var data = readInventoryRows_();
  var rows = data.rows;
  var q = String(filters.q || '').toLowerCase();
  var pri = String(filters.priority || '').toUpperCase();
  var dep = String(filters.deploy || '').toLowerCase();
  var cat = String(filters.category || '').toLowerCase();
  var hasCi = String(filters.hasCi || '');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (q) {
      var blob = (r.Repo + ' ' + r.Description + ' ' + r.Topics + ' ' + r['Tech stack']).toLowerCase();
      if (blob.indexOf(q) === -1) continue;
    }
    if (pri && String(r.Priority || '').toUpperCase() !== pri) continue;
    if (dep && String(r['Deploy status'] || '').toLowerCase().indexOf(dep) === -1) continue;
    if (cat && String(r.Category || '').toLowerCase().indexOf(cat) === -1) continue;
    if (hasCi === 'yes' && !/^yes/i.test(String(r['Has CI'] || ''))) continue;
    if (hasCi === 'no' && /^yes/i.test(String(r['Has CI'] || ''))) continue;
    out.push(r);
  }
  return { total: out.length, rows: out.slice(0, 500), canEdit: canEdit_() };
}

function getPriorities() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(TODAY_SHEET);
  if (!sh) return { rows: [] };
  var values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return { rows: [] };
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0] && !values[i][1]) continue;
    var obj = { _row: i + 1 };
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[i][c];
    rows.push(obj);
  }
  return { rows: rows, canEdit: canEdit_() };
}

function getDeployRows() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(DEPLOY_SHEET);
  if (!sh) return { rows: [] };
  var values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return { rows: [] };
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[i][c];
    rows.push(obj);
  }
  return { rows: rows };
}

function updatePriorityStatus(repo, status) {
  if (!canEdit_()) throw new Error('Not authorized to edit');
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(TODAY_SHEET);
  var values = sh.getDataRange().getDisplayValues();
  var headers = values[0];
  var repoCol = colIndex_(headers, 'Repo');
  var statusCol = colIndex_(headers, 'Status');
  if (repoCol < 0 || statusCol < 0) throw new Error('Repo/Status columns missing');
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][repoCol]) === String(repo)) {
      sh.getRange(i + 1, statusCol + 1).setValue(status);
      return { ok: true, repo: repo, status: status };
    }
  }
  throw new Error('Repo not found on Today & Priorities: ' + repo);
}

function getWebhookHealth() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(WEBHOOK_LOG_SHEET);
  var secretSet = !!getProp_('GITHUB_WEBHOOK_SECRET');
  if (!sh) return { secretSet: secretSet, events: [] };
  var last = sh.getLastRow();
  if (last < 2) return { secretSet: secretSet, events: [] };
  var start = Math.max(2, last - 49);
  var values = sh.getRange(start, 1, last - start + 1, 5).getDisplayValues();
  var events = [];
  for (var i = values.length - 1; i >= 0; i--) {
    events.push({
      at: values[i][0],
      event: values[i][1],
      repo: values[i][2],
      action: values[i][3],
      result: values[i][4]
    });
  }
  return { secretSet: secretSet, events: events, webAppUrl: ScriptApp.getService().getUrl() || '' };
}

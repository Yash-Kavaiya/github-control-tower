/**
 * Read API for the Control Tower web app and sidebar.
 * Inventory header is row 4. Data starts on row 5. Rows 1–3 stay untouched.
 */

function getOverviewMetrics(force) {
  var overview = null;
  if (!force) overview = cacheGetJson_('ct:overview');
  if (!overview) {
    overview = buildOverview_(loadInventoryRows_(!!force));
    overview.generatedAt = formatNow_();
    cachePutJson_('ct:overview', overview);
  }
  overview.editable = canMutate_();
  return overview;
}

function getInventoryRows(filters) {
  var rows = loadInventoryRows_(!!(filters && filters.force));
  var safe = normalizeFilters_(filters);
  var filtered = filterInventory_(rows, safe);
  return {
    rows: filtered.map(publicInventoryRow_),
    total: rows.length,
    matched: filtered.length,
    options: inventoryOptions_(rows),
    editable: canMutate_(),
    generatedAt: formatNow_()
  };
}

function getPriorities() {
  return readBoard_(CT.PRIORITIES_SHEET, ['repo', 'repository', 'project', 'status', 'priority', 'owner', 'task', 'today', 'notes', 'item']);
}

function getDeployRows() {
  return readBoard_(CT.DEPLOY_SHEET, ['repo', 'repository', 'project', 'status', 'url', 'environment', 'service', 'deploy', 'platform', 'date', 'target']);
}

function updatePriorityStatus(repo, status, rowNumber) {
  requireEditor_();
  var key = sanitizeRepoKey_(repo);
  var next = sanitizeStatus_(status);
  if (!key) throw new Error('Repository name is empty or not allowed.');
  if (!next) throw new Error('Status is empty or not allowed.');

  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CT.PRIORITIES_SHEET);
  if (!sheet) throw new Error('Sheet "Today & Priorities" was not found.');

  var table = readSheetTable_(sheet, ['repo', 'repository', 'project', 'status', 'priority', 'owner', 'task', 'item']);
  var columns = priorityColumns_(table.headers);
  if (columns.status < 0) throw new Error('Today & Priorities has no Status column.');
  if (columns.repo < 0) throw new Error('Today & Priorities has no Repo column.');

  var matches = [];
  table.rows.forEach(function (row) {
    var cell = String(row.values[columns.repo] || '').trim();
    if (cell.toLowerCase() === key.toLowerCase()) matches.push(row);
  });
  if (!matches.length) throw new Error('No priority row matches that repository.');
  var target = null;
  if (rowNumber) {
    matches.forEach(function (row) {
      if (row.rowNumber === Number(rowNumber)) target = row;
    });
    if (!target) throw new Error('That priority row does not match the repository.');
  } else if (matches.length === 1) {
    target = matches[0];
  } else {
    throw new Error('Multiple priority rows match this repository.');
  }

  sheet.getRange(target.rowNumber, columns.status + 1).setValue(next);
  return { ok: true, repo: key, status: next, rowNumber: target.rowNumber };
}

function getWebhookHealth() {
  var ss = getSpreadsheet_();
  var created = false;
  var sheet = ss.getSheetByName(CT.WEBHOOK_SHEET);
  if (!sheet) {
    sheet = createWebhookLogSheet_(ss);
    created = true;
  }
  var entries = readWebhookEntries_(sheet);
  var counts = {};
  entries.forEach(function (entry) {
    var name = entry.event || 'unknown';
    counts[name] = (counts[name] || 0) + 1;
  });
  return {
    secretConfigured: !!getScriptProperty_('GITHUB_WEBHOOK_SECRET'),
    tokenConfigured: !!getScriptProperty_('GITHUB_TOKEN'),
    geminiConfigured: !!getScriptProperty_('GEMINI_API_KEY'),
    autoClassify: isAutoClassifyEnabled_(getScriptProperty_('AI_AUTO_CLASSIFY')),
    editorsConfigured: !!getScriptProperty_('CONTROL_TOWER_EDITORS'),
    editable: canMutate_(),
    webAppUrl: getWebAppUrl(),
    logSheet: CT.WEBHOOK_SHEET,
    createdSheet: created,
    lastEvent: entries.length ? entries[0] : null,
    events: entries,
    recentCounts: counts,
    headerNote: 'Apps Script web apps do not receive X-Hub-Signature-256. Put the same secret in the payload URL as ?token=. The script still verifies the signature header when a front door forwards it.'
  };
}

function enrichInventoryRepo(repo) {
  requireEditor_();
  var key = sanitizeRepoKey_(repo);
  if (!key) throw new Error('Repository name is empty or not allowed.');
  var token = getScriptProperty_('GITHUB_TOKEN');

  var loaded = readInventoryFromSheet_();
  var match = findInventoryMatch_(loaded.rows, repoShortName_(key), key.indexOf('/') > 0 ? key : '');
  if (match < 0) throw new Error(match === -2 ? 'More than one inventory row matches that repository.' : 'No inventory row matches that repository.');
  var current = loaded.rows[match];
  var coords = repoCoordinates_(current.repo, current.url);
  if (!coords && key.indexOf('/') > 0) coords = repoCoordinates_(key, '');
  if (!coords) throw new Error('This row needs an owner/repo name or a github.com URL before it can be enriched.');

  var repoJson = githubGet_('/repos/' + coords.owner + '/' + coords.repo, token);
  var readmeCode = githubStatus_('/repos/' + coords.owner + '/' + coords.repo + '/readme', token);
  var workflows = githubGetOptional_('/repos/' + coords.owner + '/' + coords.repo + '/actions/workflows', token);

  var values = {};
  if (repoJson.full_name && String(current.repo || '').trim() === '') values.repo = repoJson.full_name;
  if (repoJson.html_url) values.url = repoJson.html_url;
  if (typeof repoJson.description === 'string') values.description = repoJson.description;
  if (repoJson.visibility) values.visibility = formatVisibility_(repoJson.visibility, current.visibility);
  if (typeof repoJson.stargazers_count === 'number') values.stars = repoJson.stargazers_count;
  if (typeof repoJson.fork === 'boolean') values.fork = formatYesNo_(repoJson.fork, current.fork);
  if (Array.isArray(repoJson.topics) && repoJson.topics.length) values.topics = repoJson.topics.join(', ');
  if (readmeCode === 200) values.hasReadme = formatYesNo_(true, current.hasReadme);
  else if (readmeCode === 404) values.hasReadme = formatYesNo_(false, current.hasReadme);
  if (workflows && typeof workflows.total_count === 'number' && workflows.total_count > 0) {
    values.hasCi = formatYesNo_(true, current.hasCi);
  }

  writeInventoryValues_(loaded.sheet, loaded.headerMap, loaded.colCount, current._rowNumber, values);
  invalidateCache_();
  return { ok: true, repo: repoJson.full_name || key, updated: Object.keys(values) };
}

function loadInventoryRows_(force) {
  if (!force) {
    var cached = readInventoryCache_();
    if (cached) return cached;
  }
  var loaded = readInventoryFromSheet_();
  writeInventoryCache_(loaded.rows);
  return loaded.rows;
}

function readInventoryFromSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CT.INVENTORY_SHEET);
  if (!sheet) throw new Error('Sheet "Full Inventory" was not found.');
  var lastCol = Math.max(sheet.getLastColumn(), INVENTORY_FIELDS.length);
  var headers = sheet.getRange(CT.INVENTORY_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  var headerMap = mapHeaders_(headers, INVENTORY_FIELDS);
  if (headerMap.repo < 0) {
    throw new Error('Full Inventory header row 4 is missing a Repo column.');
  }
  var lastRow = sheet.getLastRow();
  var rows = [];
  if (lastRow >= CT.INVENTORY_DATA_START) {
    var values = sheet.getRange(CT.INVENTORY_DATA_START, 1, lastRow - CT.INVENTORY_DATA_START + 1, lastCol).getValues();
    rows = rowsFromInventoryValues_(headerMap, values);
  }
  return { sheet: sheet, headerMap: headerMap, colCount: lastCol, rows: rows };
}

function rowsFromInventoryValues_(headerMap, valueRows) {
  var rows = [];
  (valueRows || []).forEach(function (raw, index) {
    var record = { _rowNumber: CT.INVENTORY_DATA_START + index };
    var any = false;
    INVENTORY_FIELDS.forEach(function (field) {
      var idx = headerMap[field.key];
      var value = idx >= 0 && idx < raw.length ? cellToPrimitive_(raw[idx]) : '';
      if (String(value) !== '') any = true;
      record[field.key] = value;
    });
    if (any && String(record.repo || '').trim()) rows.push(record);
  });
  return rows;
}

function cellToPrimitive_(value) {
  if (value instanceof Date) {
    try {
      return Utilities.formatDate(value, CT.TIMEZONE, 'yyyy-MM-dd');
    } catch (err) {
      return value.toISOString();
    }
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value;
  return String(value == null ? '' : value).trim();
}

function publicInventoryRow_(row) {
  return {
    rowNumber: row._rowNumber,
    repo: clip_(row.repo, 180),
    url: safeUrl_(row.url),
    description: clip_(row.description, 280),
    visibility: clip_(row.visibility, 40),
    stars: row.stars === '' ? '' : row.stars,
    fork: clip_(row.fork, 20),
    topics: clip_(row.topics, 180),
    hasReadme: clip_(row.hasReadme, 20),
    hasCi: clip_(row.hasCi, 20),
    deployStatus: clip_(row.deployStatus, 80),
    security: clip_(row.security, 80),
    category: clip_(row.category, 80),
    stack: clip_(row.stack, 120),
    score: row.score === '' ? '' : row.score,
    priority: clip_(row.priority, 40),
    plan: clip_(row.plan, 180)
  };
}

function clip_(value, max) {
  var text = String(value == null ? '' : value);
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function safeUrl_(value) {
  var text = String(value || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  return '';
}

function buildOverview_(rows) {
  var p1 = 0;
  var p2 = 0;
  var p3 = 0;
  var other = 0;
  var nvidia = 0;
  var gcp = 0;
  var deployed = 0;
  var ciYes = 0;
  var scoreSum = 0;
  var scored = 0;
  var categories = {};
  var deploys = {};
  (rows || []).forEach(function (row) {
    var bucket = priorityBucket_(row.priority);
    if (bucket === 'P1') p1++;
    else if (bucket === 'P2') p2++;
    else if (bucket === 'P3') p3++;
    else other++;
    if (isNvidia_(row)) nvidia++;
    if (isGcp_(row)) gcp++;
    if (isDeployed_(row.deployStatus)) deployed++;
    if (isYes_(row.hasCi)) ciYes++;
    var score = parseScore_(row.score);
    if (score != null) {
      scoreSum += score;
      scored++;
    }
    var cat = String(row.category || '').trim() || 'Uncategorized';
    categories[cat] = (categories[cat] || 0) + 1;
    var dep = String(row.deployStatus || '').trim() || 'Unset';
    deploys[dep] = (deploys[dep] || 0) + 1;
  });
  var total = rows ? rows.length : 0;
  return {
    total: total,
    p1: p1,
    p2: p2,
    p3: p3,
    otherPriority: other,
    nvidia: nvidia,
    gcp: gcp,
    deployed: deployed,
    avgScore: scored ? Math.round((scoreSum / scored) * 10) / 10 : null,
    scoredCount: scored,
    ciYes: ciYes,
    ciCoverage: total ? Math.round((ciYes / total) * 1000) / 10 : null,
    categories: topCounts_(categories),
    deployMix: topCounts_(deploys)
  };
}

function topCounts_(map) {
  return Object.keys(map).map(function (name) {
    return { name: name, count: map[name] };
  }).sort(function (a, b) {
    return b.count - a.count || a.name.localeCompare(b.name);
  }).slice(0, 8);
}

function priorityBucket_(value) {
  var raw = String(value == null ? '' : value).toUpperCase().replace(/\s+/g, '');
  if (!raw) return '';
  if (raw === 'P1' || raw === '1' || raw.indexOf('P1') === 0) return 'P1';
  if (raw === 'P2' || raw === '2' || raw.indexOf('P2') === 0) return 'P2';
  if (raw === 'P3' || raw === '3' || raw.indexOf('P3') === 0) return 'P3';
  var match = raw.match(/P([123])/);
  return match ? 'P' + match[1] : '';
}

function isYes_(value) {
  var v = String(value == null ? '' : value).trim().toLowerCase();
  return v === 'yes' || v === 'y' || v === 'true' || v === '1' || v === '✓' || v === '✔';
}

function isNvidia_(row) {
  return /nvidia/.test(rowBlob_(row));
}

function isGcp_(row) {
  return /\bgcp\b|google[\s-]?cloud|\bgke\b|cloud run|app engine|vertex|bigquery|compute engine/.test(rowBlob_(row));
}

function rowBlob_(row) {
  return [row.category, row.stack, row.topics, row.repo, row.description].join(' ').toLowerCase();
}

function isDeployed_(value) {
  var v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return false;
  if (/(fail|error|block|pending|progress|wip|draft|todo|hold|queue|not |n't|undeploy|un-deploy|n\/a|none|^no\b|\bno\b|ready to|to do|planned)/.test(v)) return false;
  if (v === 'yes' || v === 'y' || v === 'true' || v === 'live' || v === 'shipped' || v === 'published') return true;
  return /(deployed|\blive\b|production|in prod|shipped|released|published)/.test(v);
}

function parseScore_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  var text = String(value == null ? '' : value).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function normalizeFilters_(filters) {
  var src = filters || {};
  return {
    query: String(src.query || '').trim().slice(0, 100).toLowerCase(),
    priority: String(src.priority || '').trim().toUpperCase(),
    deployStatus: String(src.deployStatus || '').trim(),
    category: String(src.category || '').trim(),
    hasCi: String(src.hasCi || '').trim().toLowerCase()
  };
}

function filterInventory_(rows, filters) {
  var spec = filters || normalizeFilters_();
  return (rows || []).filter(function (row) {
    if (spec.priority) {
      var bucket = priorityBucket_(row.priority) || 'OTHER';
      if (bucket !== spec.priority) return false;
    }
    if (spec.deployStatus && String(row.deployStatus || '') !== spec.deployStatus) return false;
    if (spec.category && String(row.category || '') !== spec.category) return false;
    if (spec.hasCi === 'yes' && !isYes_(row.hasCi)) return false;
    if (spec.hasCi === 'no' && isYes_(row.hasCi)) return false;
    if (spec.query) {
      var blob = [row.repo, row.description, row.topics, row.stack, row.category, row.plan, row.url, row.visibility].join(' ').toLowerCase();
      if (blob.indexOf(spec.query) === -1) return false;
    }
    return true;
  });
}

function inventoryOptions_(rows) {
  var deploy = {};
  var category = {};
  var hasOther = false;
  (rows || []).forEach(function (row) {
    if (row.deployStatus !== '' && row.deployStatus != null) deploy[String(row.deployStatus)] = 1;
    if (row.category !== '' && row.category != null) category[String(row.category)] = 1;
    if (String(row.priority || '').trim() && !priorityBucket_(row.priority)) hasOther = true;
  });
  var priorities = ['P1', 'P2', 'P3'];
  if (hasOther) priorities.push('OTHER');
  return {
    priorities: priorities,
    deployStatuses: Object.keys(deploy).sort().slice(0, 40),
    categories: Object.keys(category).sort().slice(0, 40)
  };
}

function readBoard_(sheetName, hints) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    return {
      missing: true,
      sheetName: sheetName,
      headers: [],
      rows: [],
      columns: { repo: -1, status: -1 },
      editable: false,
      message: 'Sheet "' + sheetName + '" was not found. Existing tabs are left as they are.'
    };
  }
  var table = readSheetTable_(sheet, hints);
  var columns = priorityColumns_(table.headers);
  return {
    missing: false,
    sheetName: sheetName,
    headerRow: table.headerRow,
    headers: table.headers,
    columns: columns,
    editable: columns.status >= 0 && canMutate_(),
    rows: table.rows.map(function (row) {
      return {
        rowNumber: row.rowNumber,
        values: row.values,
        repo: columns.repo >= 0 ? String(row.values[columns.repo] || '') : '',
        status: columns.status >= 0 ? String(row.values[columns.status] || '') : ''
      };
    })
  };
}

function readSheetTable_(sheet, hints) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (!lastRow || !lastCol) {
    return { headerRow: 1, headers: [], rows: [] };
  }
  var values = sheet.getRange(1, 1, Math.min(lastRow, 2000), lastCol).getValues();
  var headerIndex = detectHeaderRow_(values, hints || []);
  var headers = values[headerIndex].map(function (cell) { return String(cell == null ? '' : cell).trim(); });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  var rows = [];
  var r;
  for (r = headerIndex + 1; r < values.length; r++) {
    var slice = values[r].slice(0, headers.length).map(cellToPrimitive_);
    var any = slice.some(function (cell) { return String(cell) !== ''; });
    if (!any) continue;
    rows.push({ rowNumber: r + 1, values: slice });
  }
  return { headerRow: headerIndex + 1, headers: headers, rows: rows };
}

function detectHeaderRow_(values, hints) {
  var bestRow = 0;
  var bestScore = -1;
  var limit = Math.min(values.length, 12);
  var hintSet = {};
  (hints || []).forEach(function (hint) { hintSet[normalizeHeader_(hint)] = 1; });
  var r;
  for (r = 0; r < limit; r++) {
    var score = 0;
    var nonEmpty = 0;
    var c;
    for (c = 0; c < values[r].length; c++) {
      var cell = normalizeHeader_(values[r][c]);
      if (!cell) continue;
      nonEmpty++;
      if (hintSet[cell]) score += 3;
      else if (cell.length > 1 && cell.length < 40) score += 1;
    }
    if (nonEmpty >= 2 && score > bestScore) {
      bestScore = score;
      bestRow = r;
    }
  }
  return bestRow;
}

function priorityColumns_(headers) {
  var map = mapHeaders_(headers, [
    { key: 'repo', labels: ['repo', 'repository', 'project', 'name', 'item'] },
    { key: 'status', labels: ['status', 'state'] }
  ]);
  return map;
}

function writeInventoryCache_(rows) {
  try {
    var cache = CacheService.getScriptCache();
    var chunks = [];
    var current = [];
    var size = 2;
    (rows || []).forEach(function (row) {
      var piece = JSON.stringify(row);
      if (size + piece.length > 80000 && current.length) {
        chunks.push(current);
        current = [];
        size = 2;
      }
      current.push(row);
      size += piece.length + 1;
    });
    if (current.length || !chunks.length) chunks.push(current);
    var prev = cacheGetJson_('ct:inv:meta');
    var prevN = prev && prev.n ? Number(prev.n) : 0;
    var i;
    for (i = 0; i < chunks.length; i++) cachePutJson_('ct:inv:' + i, chunks[i]);
    for (i = chunks.length; i < prevN; i++) cache.remove('ct:inv:' + i);
    cachePutJson_('ct:inv:meta', { n: chunks.length, at: Date.now() });
  } catch (err) {}
}

function readInventoryCache_() {
  var meta = cacheGetJson_('ct:inv:meta');
  if (!meta || !meta.n) return null;
  var rows = [];
  var i;
  for (i = 0; i < meta.n; i++) {
    var chunk = cacheGetJson_('ct:inv:' + i);
    if (!chunk) return null;
    rows = rows.concat(chunk);
  }
  return rows;
}

function repoCoordinates_(repoCell, url) {
  var fromUrl = String(url || '').match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (fromUrl) return { owner: fromUrl[1], repo: fromUrl[2].replace(/\.git$/, '') };
  var fromName = String(repoCell || '').trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (fromName) return { owner: fromName[1], repo: fromName[2].replace(/\.git$/, '') };
  return null;
}

function repoShortName_(name) {
  var text = String(name || '').trim();
  var parts = text.split('/');
  return parts[parts.length - 1];
}

function githubGet_(path, token) {
  var response = UrlFetchApp.fetch('https://api.github.com' + path, {
    method: 'get',
    headers: githubHeaders_(token),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  if (code < 200 || code >= 300) {
    var headers = {};
    try { headers = response.getHeaders() || {}; } catch (err) { headers = {}; }
    throw new Error(githubFailureMessage_(code, text, headers, !!token, path));
  }
  return JSON.parse(text || '{}');
}

function githubGetOptional_(path, token) {
  try {
    var response = UrlFetchApp.fetch('https://api.github.com' + path, {
      headers: githubHeaders_(token),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) return null;
    return JSON.parse(response.getContentText() || '{}');
  } catch (err) {
    return null;
  }
}

function githubStatus_(path, token) {
  var response = UrlFetchApp.fetch('https://api.github.com' + path, {
    headers: githubHeaders_(token),
    muteHttpExceptions: true
  });
  return response.getResponseCode();
}

function githubHeaders_(token) {
  var headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-control-tower',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

function headerValue_(headers, name) {
  if (!headers) return '';
  var target = String(name || '').toLowerCase();
  var keys = Object.keys(headers);
  var i;
  for (i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === target) return String(headers[keys[i]] == null ? '' : headers[keys[i]]);
  }
  return '';
}

function githubFailureMessage_(code, body, headers, hasToken, path) {
  var text = String(body || '');
  var remaining = headerValue_(headers, 'X-RateLimit-Remaining');
  var rateLimited = code === 429 || remaining === '0' || /rate limit/i.test(text) || /secondary rate/i.test(text);
  var where = path ? ' for ' + path : '';
  if ((code === 403 || code === 429) && rateLimited) {
    if (!hasToken) return 'GitHub rate limit reached for unauthenticated requests. Set GITHUB_TOKEN in Script properties to raise the limit.';
    return 'GitHub rate limit reached. Wait for the rate-limit window to reset, then try again.';
  }
  if (code === 401) return 'GitHub rejected the credentials (HTTP 401). Check GITHUB_TOKEN in Script properties.';
  if (code === 404 && !hasToken) return 'GitHub returned HTTP 404' + where + '. If the repository is private, set GITHUB_TOKEN in Script properties.';
  if (code === 403 && !hasToken) return 'GitHub returned HTTP 403' + where + '. Set GITHUB_TOKEN in Script properties if this repository is private.';
  return 'GitHub returned HTTP ' + code + where + '.';
}

/**
 * Gemini classification for Full Inventory.
 *
 * Script properties:
 *   GEMINI_API_KEY     required to classify (Google AI Studio key)
 *   GEMINI_MODEL       optional; default gemini-3.8-flash
 *   GITHUB_TOKEN       optional bearer token for repo metadata, languages, and README
 *   AI_AUTO_CLASSIFY   optional; set to true to classify new or unclassified rows
 *                      after a repository webhook or a default-branch push
 *
 * Keys are read only from PropertiesService. They are never written to the sheet,
 * logs, or client responses.
 */

var AI_BATCH_DEFAULT = 5;
var AI_BATCH_MAX = 8;
var AI_BATCH_PAUSE_MS = 1200;
var AI_README_LIMIT = 1200;

function getAiStatus() {
  var model = 'gemini-3.8-flash';
  try { model = geminiModel_(); } catch (err) { model = 'gemini-3.8-flash'; }
  return {
    geminiConfigured: !!getScriptProperty_('GEMINI_API_KEY'),
    githubTokenConfigured: !!getScriptProperty_('GITHUB_TOKEN'),
    autoClassify: isAutoClassifyEnabled_(getScriptProperty_('AI_AUTO_CLASSIFY')),
    model: model,
    editable: canMutate_()
  };
}

function classifyRepo(owner, name) {
  requireEditor_();
  var gate = geminiConfiguredError_();
  if (gate) return gate;
  var loaded = readInventoryFromSheet_();
  var ownerText = String(owner || '').trim();
  var nameText = String(name || '').trim();
  var key = ownerText && nameText ? ownerText + '/' + nameText : (ownerText || nameText);
  var located = locateInventoryRow_(loaded.rows, key);
  if (!located.ok) return located;
  var result = classifyLoadedRow_(loaded, located.row);
  if (result.ok) invalidateCache_();
  return publicClassifyResult_(result);
}

function classifySelectedRepos(repos) {
  requireEditor_();
  var gate = geminiConfiguredError_();
  if (gate) return { ok: false, classified: 0, limit: 0, error: gate.error, results: [] };
  var list = [];
  if (Array.isArray(repos)) {
    repos.forEach(function (item) {
      var key = '';
      if (item && typeof item === 'object') key = sanitizeRepoKey_(item.repo || item.full_name || item.name || '');
      else key = sanitizeRepoKey_(item);
      if (key) list.push(key);
    });
  }
  if (!list.length) return { ok: false, classified: 0, limit: 0, error: 'Select at least one repository.', results: [] };
  var limit = clampBatchLimit_(list.length);
  var loaded = readInventoryFromSheet_();
  var results = [];
  var i;
  for (i = 0; i < list.length && results.length < limit; i++) {
    var located = locateInventoryRow_(loaded.rows, list[i]);
    if (!located.ok) results.push({ ok: false, repo: list[i], error: located.error });
    else results.push(classifyLoadedRow_(loaded, located.row));
    if (results.length < limit && i < list.length - 1) pauseAi_();
  }
  invalidateCache_();
  return summarizeClassify_(results, limit);
}

function classifyInventoryBatch(limit) {
  requireEditor_();
  var gate = geminiConfiguredError_();
  if (gate) return { ok: false, classified: 0, limit: clampBatchLimit_(limit), error: gate.error, results: [], skipped: 0 };
  var loaded = readInventoryFromSheet_();
  var partition = partitionUnclassified_(loaded.rows, limit);
  if (!partition.ready.length) {
    return {
      ok: true,
      classified: 0,
      limit: partition.limit,
      skipped: partition.skipped,
      error: '',
      message: partition.skipped
        ? 'Unclassified rows need an owner/repo name or a github.com URL before they can be classified.'
        : 'No unclassified repositories are waiting.',
      results: []
    };
  }
  var results = [];
  var i;
  for (i = 0; i < partition.ready.length; i++) {
    results.push(classifyLoadedRow_(loaded, partition.ready[i]));
    if (i < partition.ready.length - 1) pauseAi_();
  }
  invalidateCache_();
  var summary = summarizeClassify_(results, partition.limit);
  summary.skipped = partition.skipped;
  if (partition.ready.length === partition.limit) summary.message = 'More unclassified rows may remain.';
  return summary;
}

function listOwnerRepos(owner) {
  requireEditor_();
  var name = String(owner || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(name)) {
    return { ok: false, error: 'Owner must be a GitHub user or organization login.' };
  }
  var token = getScriptProperty_('GITHUB_TOKEN');
  try {
    var repos = listGithubReposForOwner_(name, token, 30);
    return { ok: true, owner: name, authenticated: !!token, repos: repos };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) };
  }
}

function maybeAutoClassify_(eventName, payload, outcome) {
  try {
    var enabled = getScriptProperty_('AI_AUTO_CLASSIFY');
    if (!isAutoClassifyEnabled_(enabled)) return '';
    if (!getScriptProperty_('GEMINI_API_KEY')) return '';
    if (!outcome || (outcome.result !== 'inserted' && outcome.result !== 'updated')) return '';
    var repository = payload && payload.repository ? payload.repository : {};
    var loaded = readInventoryFromSheet_();
    var match = findInventoryMatch_(loaded.rows, repository.name || '', repository.full_name || outcome.repo || '');
    if (match < 0) return '';
    var row = loaded.rows[match];
    if (!shouldAutoClassifyEvent_(eventName, payload, outcome.result === 'inserted', row.priority, enabled)) return '';
    var result = classifyLoadedRow_(loaded, row);
    if (!result.ok) return 'classify skipped: ' + String(result.error || 'unknown error').slice(0, 180);
    return 'classified ' + result.classification.priority;
  } catch (err) {
    return 'classify skipped: ' + String(err && err.message ? err.message : err).slice(0, 180);
  }
}

function geminiConfiguredError_() {
  if (getScriptProperty_('GEMINI_API_KEY')) return null;
  return {
    ok: false,
    error: 'GEMINI_API_KEY is not set. Add it under Project settings → Script properties, then run Classify again.'
  };
}

function locateInventoryRow_(rows, key) {
  var safe = sanitizeRepoKey_(key);
  if (!safe) return { ok: false, error: 'Repository name is empty or not allowed.' };
  var match = findInventoryMatch_(rows, repoShortName_(safe), safe.indexOf('/') > 0 ? safe : '');
  if (match === -2) return { ok: false, error: 'More than one inventory row matches that repository.' };
  if (match < 0) return { ok: false, error: 'No inventory row matches that repository.' };
  return { ok: true, row: rows[match] };
}

function classifyLoadedRow_(loaded, row) {
  var key = getScriptProperty_('GEMINI_API_KEY');
  if (!key) return { ok: false, repo: row.repo, error: geminiConfiguredError_().error };
  var coords = repoCoordinates_(row.repo, row.url);
  if (!coords) {
    return {
      ok: false,
      repo: row.repo,
      error: 'This row needs an owner/repo name or a github.com URL before it can be classified.'
    };
  }
  var token = getScriptProperty_('GITHUB_TOKEN');
  var repoJson;
  var languages = {};
  var readmeText = '';
  try {
    repoJson = githubGet_('/repos/' + coords.owner + '/' + coords.repo, token);
    languages = githubGetOptional_('/repos/' + coords.owner + '/' + coords.repo + '/languages', token) || {};
    var readme = githubGetOptional_('/repos/' + coords.owner + '/' + coords.repo + '/readme', token);
    if (readme && readme.content) readmeText = decodeGithubBase64_(readme.content);
  } catch (err) {
    return { ok: false, repo: coords.owner + '/' + coords.repo, error: String(err && err.message ? err.message : err) };
  }
  var context = buildRepoClassifyContext_(repoJson, languages, readmeText);
  var response;
  try {
    response = callGemini_(key, buildGeminiRequestBody_(context));
  } catch (err) {
    return { ok: false, repo: context.full_name || row.repo, error: String(err && err.message ? err.message : err) };
  }
  var parsed = parseGeminiClassification_(response);
  if (!parsed.ok) return { ok: false, repo: context.full_name || row.repo, error: parsed.error };
  var patch = classificationSheetPatch_(parsed.classification, row);
  writeInventoryValues_(loaded.sheet, loaded.headerMap, loaded.colCount, row._rowNumber, patch);
  if (patch.priority) row.priority = patch.priority;
  if (patch.stack) row.stack = patch.stack;
  if (patch.deployStatus) row.deployStatus = patch.deployStatus;
  return {
    ok: true,
    repo: context.full_name || (coords.owner + '/' + coords.repo),
    rowNumber: row._rowNumber,
    classification: parsed.classification,
    updated: Object.keys(patch)
  };
}

function listGithubReposForOwner_(owner, token, limit) {
  var cap = Number(limit);
  if (!isFinite(cap) || cap < 1) cap = 30;
  if (cap > 100) cap = 100;
  var query = '?per_page=' + cap + '&sort=updated';
  var repos;
  try {
    repos = githubGet_('/users/' + encodeURIComponent(owner) + '/repos' + query + '&type=owner', token);
  } catch (err) {
    var message = String(err && err.message ? err.message : err);
    if (message.indexOf('HTTP 404') === -1) throw err;
    repos = githubGet_('/orgs/' + encodeURIComponent(owner) + '/repos' + query + '&type=all', token);
  }
  return summarizeGithubRepos_(repos);
}

function summarizeGithubRepos_(repos) {
  if (!Array.isArray(repos)) return [];
  return repos.map(function (repo) {
    return {
      full_name: repo && repo.full_name ? String(repo.full_name) : '',
      description: clipText_(repo && repo.description ? repo.description : '', 180),
      private: !!(repo && repo.private),
      language: repo && repo.language ? String(repo.language) : '',
      html_url: repo && repo.html_url ? String(repo.html_url) : '',
      stargazers_count: repo && typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
      topics: Array.isArray(repo && repo.topics) ? repo.topics.slice(0, 8).map(function (topic) { return String(topic); }) : []
    };
  }).filter(function (repo) { return repo.full_name; });
}

function callGemini_(apiKey, body) {
  var model = geminiModel_();
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (err) {
    throw new Error('Gemini request failed. Confirm the script can reach generativelanguage.googleapis.com.');
  }
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  if (code < 200 || code >= 300) throw new Error(geminiHttpError_(code, text));
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Gemini returned a non-JSON response.');
  }
}

function geminiModel_() {
  var custom = String(getScriptProperty_('GEMINI_MODEL') || '').trim();
  if (/^gemini-[a-z0-9][a-z0-9.\-]{0,60}$/i.test(custom)) return custom;
  return 'gemini-3.8-flash';
}

function geminiHttpError_(code, body) {
  var message = '';
  try {
    var obj = JSON.parse(body || '{}');
    if (obj && obj.error && obj.error.message) message = String(obj.error.message);
  } catch (err) {}
  message = message.replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[redacted]');
  if (code === 400 && /api key/i.test(message)) return 'Gemini rejected GEMINI_API_KEY. Check the key in Script properties.';
  if (code === 401 || code === 403) return 'Gemini rejected GEMINI_API_KEY (HTTP ' + code + '). Check the key in Script properties.';
  if (code === 429) return 'Gemini rate limit reached. Wait and try a smaller batch.';
  if (code === 404) return 'Gemini model was not found. Set GEMINI_MODEL to a current flash model such as gemini-3.8-flash.';
  if (message) return 'Gemini returned HTTP ' + code + ': ' + message.slice(0, 180);
  return 'Gemini returned HTTP ' + code + '.';
}

function pauseAi_() {
  try { Utilities.sleep(AI_BATCH_PAUSE_MS); } catch (err) {}
}

function summarizeClassify_(results, limit) {
  var okCount = 0;
  var firstError = '';
  (results || []).forEach(function (item) {
    if (item && item.ok) okCount++;
    else if (!firstError && item && item.error) firstError = String(item.error);
  });
  return {
    ok: okCount > 0 || !firstError,
    classified: okCount,
    limit: limit,
    error: okCount ? '' : firstError,
    results: (results || []).map(publicClassifyResult_)
  };
}

function publicClassifyResult_(item) {
  var classification = item && item.classification ? item.classification : null;
  return {
    ok: !!(item && item.ok),
    repo: clip_(item && item.repo, 180),
    rowNumber: item && item.rowNumber ? item.rowNumber : 0,
    error: item && item.error ? clip_(item.error, 300) : '',
    updated: item && item.updated ? item.updated.slice(0, 8) : [],
    classification: classification ? {
      priority: classification.priority,
      tech_stack: clip_(classification.tech_stack, 180),
      deploy_status: classification.deploy_status,
      rationale: clip_(classification.rationale, 400),
      tags: (classification.tags || []).slice(0, 6)
    } : null
  };
}

function clampBatchLimit_(limit) {
  var n = Number(limit);
  if (!isFinite(n) || n < 1) return AI_BATCH_DEFAULT;
  n = Math.floor(n);
  if (n > AI_BATCH_MAX) return AI_BATCH_MAX;
  return n;
}

function isAutoClassifyEnabled_(value) {
  var flag = String(value == null ? '' : value).trim().toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'yes' || flag === 'y';
}

function isUnclassifiedPriority_(value) {
  return !priorityBucket_(value);
}

function partitionUnclassified_(rows, limit) {
  var n = clampBatchLimit_(limit);
  var ready = [];
  var skipped = 0;
  (rows || []).forEach(function (row) {
    if (!row || !String(row.repo || '').trim()) return;
    if (!isUnclassifiedPriority_(row.priority)) return;
    if (!repoCoordinates_(row.repo, row.url)) {
      skipped++;
      return;
    }
    if (ready.length < n) ready.push(row);
  });
  return { ready: ready, skipped: skipped, limit: n };
}

function shouldAutoClassifyEvent_(eventName, payload, isNewRow, priority, enabledFlag) {
  if (!isAutoClassifyEnabled_(enabledFlag)) return false;
  var event = String(eventName || '').toLowerCase();
  if (event !== 'repository' && event !== 'push') return false;
  var action = payload && payload.action ? String(payload.action).toLowerCase() : '';
  if (event === 'repository' && (action === 'deleted' || action === 'transferred')) return false;
  if (event === 'push' && !isSignificantPush_(payload)) return false;
  if (!isNewRow && !isUnclassifiedPriority_(priority)) return false;
  return true;
}

function isSignificantPush_(payload) {
  var ref = payload && payload.ref ? String(payload.ref) : '';
  if (ref.indexOf('refs/heads/') !== 0) return false;
  var repository = payload && payload.repository ? payload.repository : {};
  if (repository.default_branch) return ref === 'refs/heads/' + repository.default_branch;
  return ref === 'refs/heads/main' || ref === 'refs/heads/master';
}

function buildRepoClassifyContext_(repoJson, languages, readmeText) {
  var repo = repoJson || {};
  var langMap = languages && typeof languages === 'object' && !Array.isArray(languages) ? languages : {};
  var names = Object.keys(langMap).filter(function (name) { return typeof langMap[name] === 'number'; });
  names.sort(function (a, b) { return langMap[b] - langMap[a]; });
  return {
    name: repo.name ? String(repo.name) : '',
    full_name: repo.full_name ? String(repo.full_name) : '',
    description: clipText_(repo.description || '', 400),
    language: repo.language ? String(repo.language) : '',
    languages: names.slice(0, 6),
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 12).map(function (topic) { return String(topic); }) : [],
    homepage: repo.homepage ? String(repo.homepage) : '',
    visibility: repo.visibility ? String(repo.visibility) : (repo.private ? 'private' : 'public'),
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : null,
    has_pages: !!repo.has_pages,
    default_branch: repo.default_branch ? String(repo.default_branch) : '',
    readme_snippet: clipReadmeSnippet_(readmeText, AI_README_LIMIT)
  };
}

function buildClassifyPrompt_(context) {
  return [
    'Classify this GitHub repository for an engineering inventory.',
    'Choose priority P1, P2, or P3. P1 is production or high-value and should be tracked closely. P2 is useful, active, or promising. P3 is an experiment, archive, learning repo, or low urgency.',
    'tech_stack is a short summary of languages and frameworks.',
    'deploy_status is live when a real user-facing deployment is evident, demo for a sample, staging, or docs site, and none when there is no deployment signal.',
    'rationale is one or two sentences. tags is up to 6 short labels.',
    'Repository context:',
    JSON.stringify(context || {})
  ].join('\n');
}

function geminiResponseSchema_() {
  return {
    type: 'object',
    properties: {
      priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
      tech_stack: { type: 'string' },
      deploy_status: { type: 'string', enum: ['live', 'demo', 'none'] },
      rationale: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } }
    },
    required: ['priority', 'tech_stack', 'deploy_status', 'rationale']
  };
}

function buildGeminiRequestBody_(context) {
  return {
    contents: [{ role: 'user', parts: [{ text: buildClassifyPrompt_(context) }] }],
    generationConfig: {
      temperature: 0.2,
      responseFormat: {
        text: {
          mimeType: 'application/json',
          schema: geminiResponseSchema_()
        }
      },
      thinkingConfig: { thinkingLevel: 'low' }
    }
  };
}

function parseGeminiClassification_(raw) {
  var obj = raw && typeof raw === 'object' && !raw.candidates && raw.priority != null
    ? raw
    : parseJsonObject_(extractGeminiText_(raw));
  if (!obj) return { ok: false, error: 'Gemini did not return JSON.' };
  var priority = normalizePriorityToken_(obj.priority);
  if (!priority) return { ok: false, error: 'Gemini priority was not P1, P2, or P3.' };
  var deploy = normalizeDeployHint_(obj.deploy_status != null ? obj.deploy_status : (obj.deployStatus != null ? obj.deployStatus : obj.deploy));
  if (!deploy) deploy = 'none';
  var stack = clipText_(obj.tech_stack || obj.techStack || obj.stack || '', 180);
  var rationale = clipText_(obj.rationale || obj.reason || '', 400);
  if (!rationale) return { ok: false, error: 'Gemini rationale was empty.' };
  return {
    ok: true,
    classification: {
      priority: priority,
      tech_stack: stack,
      deploy_status: deploy,
      rationale: rationale,
      tags: normalizeTags_(obj.tags)
    }
  };
}

function extractGeminiText_(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return stripJsonFence_(raw);
  var parts = [];
  var candidates = raw && raw.candidates ? raw.candidates : [];
  candidates.forEach(function (candidate) {
    var content = candidate && candidate.content;
    var list = content && content.parts ? content.parts : [];
    list.forEach(function (part) {
      if (!part || part.thought) return;
      if (typeof part.text === 'string') parts.push(part.text);
    });
  });
  if (!parts.length && raw && typeof raw.text === 'string') return stripJsonFence_(raw.text);
  return stripJsonFence_(parts.join('\n'));
}

function stripJsonFence_(text) {
  var raw = String(text || '').trim();
  var fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return raw;
}

function parseJsonObject_(text) {
  var raw = String(text || '').trim();
  if (!raw) return null;
  try {
    var direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch (err) {}
  var start = raw.indexOf('{');
  var end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      var sliced = JSON.parse(raw.slice(start, end + 1));
      if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) return sliced;
    } catch (err2) {}
  }
  return null;
}

function normalizePriorityToken_(value) {
  var raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  var compact = raw.replace(/[\s_-]+/g, '');
  if (compact === 'p1' || compact === '1' || compact === 'high' || compact === 'critical' || compact === 'urgent') return 'P1';
  if (compact === 'p2' || compact === '2' || compact === 'medium' || compact === 'med') return 'P2';
  if (compact === 'p3' || compact === '3' || compact === 'low' || compact === 'backlog') return 'P3';
  return priorityBucket_(value) || '';
}

function normalizeDeployHint_(value) {
  var raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'live' || raw === 'production' || raw === 'prod' || raw === 'deployed' || raw === 'in production') return 'live';
  if (raw === 'demo' || raw === 'staging' || raw === 'preview' || raw === 'prototype' || raw === 'sample') return 'demo';
  if (raw === 'none' || raw === 'n/a' || raw === 'na' || raw === 'not deployed' || raw === 'undeployed' || raw === 'unknown' || raw === 'no') return 'none';
  if (/demo|staging|preview|prototype/.test(raw)) return 'demo';
  if (/none|not deployed|undeployed|no deploy/.test(raw)) return 'none';
  if (/(live|production|in prod)/.test(raw) && !/not |n't/.test(raw)) return 'live';
  return '';
}

function normalizeTags_(value) {
  var list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(/[,;]+/);
  var out = [];
  list.forEach(function (item) {
    var text = String(item == null ? '' : item).trim().replace(/\s+/g, ' ');
    if (!text || text.length > 32) return;
    if (/^[=+\-@]/.test(text)) return;
    var i;
    for (i = 0; i < out.length; i++) if (out[i].toLowerCase() === text.toLowerCase()) return;
    out.push(text);
  });
  return out.slice(0, 6);
}

function classificationSheetPatch_(classification, current) {
  var values = {};
  if (!classification) return values;
  if (classification.priority) values.priority = classification.priority;
  if (classification.tech_stack) values.stack = classification.tech_stack;
  if (shouldApplyDeployHint_(current && current.deployStatus)) {
    values.deployStatus = deployHintLabel_(classification.deploy_status);
  }
  return values;
}

function shouldApplyDeployHint_(current) {
  var cur = String(current || '').trim().toLowerCase();
  if (!cur) return true;
  return cur === 'demo' || cur === 'none';
}

function deployHintLabel_(hint) {
  if (hint === 'live') return 'Live';
  if (hint === 'demo') return 'Demo';
  return 'None';
}

function clipText_(value, max) {
  var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trim() + '…';
}

function clipReadmeSnippet_(text, maxLen) {
  var raw = String(text || '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  var limit = maxLen || AI_README_LIMIT;
  if (raw.length <= limit) return raw;
  return raw.slice(0, limit).trim() + '…';
}

function decodeGithubBase64_(content) {
  var cleaned = String(content || '').replace(/\s/g, '');
  if (!cleaned) return '';
  try {
    if (typeof Utilities === 'undefined' || !Utilities.base64Decode || !Utilities.newBlob) return '';
    return Utilities.newBlob(Utilities.base64Decode(cleaned)).getDataAsString();
  } catch (err) {
    return '';
  }
}

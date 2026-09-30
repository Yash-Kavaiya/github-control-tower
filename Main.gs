/**
 * GitHub Control Tower v1
 * Bound to: Yash GitHub Review Board
 * Spreadsheet: 1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w
 */
var SPREADSHEET_ID = '1-t4uqgfBsNmDrkQCXIuuju5K1r2M0m_oSZu00aGFt1w';
var INVENTORY_SHEET = 'Full Inventory';
var TODAY_SHEET = 'Today & Priorities';
var DEPLOY_SHEET = 'Deploy Tracker';
var WEBHOOK_LOG_SHEET = 'Webhook Log';
var INVENTORY_HEADER_ROW = 4;
var INVENTORY_DATA_START = 5;

function getSpreadsheet_() {
  try {
    var active = SpreadsheetApp.getActive();
    if (active) return active;
  } catch (e) {}
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Control Tower')
    .addItem('Open sidebar KPIs', 'showSidebar')
    .addItem('Show Web app URL', 'showWebAppUrl')
    .addToUi();
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Control Tower')
    .setWidth(420);
  SpreadsheetApp.getUi().showSidebar(html);
}

function showWebAppUrl() {
  var url = ScriptApp.getService().getUrl() || '(Deploy a Web app first)';
  SpreadsheetApp.getUi().alert('Control Tower Web app\n\n' + url);
}

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'overview';
  var t = HtmlService.createTemplateFromFile('Index');
  t.initialPage = page;
  return t.evaluate()
    .setTitle('GitHub Control Tower')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

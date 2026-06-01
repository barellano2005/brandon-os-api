const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

function extractJSON(str) {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(str.slice(start, end + 1)); } catch (e) { return null; }
}

async function getSlackMessages(channelName) {
  try {
    const listResp = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200', {
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
    });
    const listData = await listResp.json();
    if (!listData.ok) throw new Error('Slack list error: ' + listData.error);
    const channel = (listData.channels || []).find(function(c) { return c.name === channelName; });
    if (!channel) return 'Channel not found: ' + channelName;
    const histResp = await fetch('https://slack.com/api/conversations.history?channel=' + channel.id + '&limit=20', {
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
    });
    const histData = await histResp.json();
    if (!histData.ok) throw new Error('Slack history error: ' + histData.error);
    return (histData.messages || []).slice(0, 15).map(function(m) { return m.text || ''; }).join('\n---\n');
  } catch(e) {
    return 'Slack error: ' + e.message;
  }
}

async function getSheetCSV(fileId) {
  try {
    const url = 'https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=csv';
    const resp = await fetch(url);
    if (!resp.ok) return 'Sheet not accessible (status ' + resp.status + ')';
    return await resp.text();
  } catch(e) {
    return 'Sheet error: ' + e.message;
  }
}

async function callClaude(messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2000, messages: messages })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error('Anthropic API error ' + response.status + ': ' + err);
  }
  return response.json();
}

app.post('/api/live-data', async function(req, res) {
  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      timeZone: 'America/New_York'
    });
    const slackMsgs = await getSlackMessages('eod-report-for-sales-team');
    const setsSheet = await getSheetCSV('1AkxdjAM884izuBY1VQpgfqdbvgUhh1YEGHsLOpSxCqE');
    const cashSheet = await getSheetCSV('1B6QTcC5elS8GSy0dszGVWMPQeDczy01i-4DDDvaQzyU');
    const prompt = 'Today is ' + today + ' EST. You are Brandon Arellano performance assistant.' +
      ' Analyze the following data and respond ONLY in JSON with no explanation.' +
      '\n\nSLACK #eod-report-for-sales-team (last 15 messages):\n' + slackMsgs.slice(0, 3000) +
      '\n\nGOOGLE SHEET - Brandon sets this week (CSV):\n' + setsSheet.slice(0, 2000) +
      '\n\nGOOGLE SHEET - Cash MTD (CSV):\n' + cashSheet.slice(0, 2000) +
      '\n\nExtract from Slack: recent closer EODs for Victor, Thomas, Luke, Joohan (last 48h).' +
      ' From sheets: Brandon sets this week count, Brandon personal cash MTD May 2026, team cash MTD May 2026.' +
      ' JSON format: {"week_sets":<n>,"brandon_personal_cash_mtd":<n>,"team_cash_mtd":<n>,' +
      '"closer_eods":[{"closer":"","date":"","calls":<n>,"offers":<n>,"closes":<n>,"cash_today":<n>,"cash_mtd":<n>,"brandon_leads":[]}]}';
    const data = await callClaude([{ role: 'user', content: prompt }]);
    const text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('');
    const parsed = extractJSON(text);
    if (parsed) {
      res.json({ success: true, data: parsed });
    } else {
      res.json({ success: false, error: 'Could not parse JSON', raw: text.slice(0, 300),
        data: { week_sets: 0, brandon_personal_cash_mtd: 0, team_cash_mtd: 0, closer_eods: [] } });
    }
  } catch (err) {
    console.error('Error:', err);
    res.json({ success: false, error: err.message,
      data: { week_sets: 0, brandon_personal_cash_mtd: 0, team_cash_mtd: 0, closer_eods: [] } });
  }
});

app.get('/', function(req, res) {
  res.json({ status: 'Brandon OS API running', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Brandon OS API running on port ' + PORT);
});

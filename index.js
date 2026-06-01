const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const EOD_CHANNEL = 'C04J6N56PTK';

function extractJSON(str) {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(str.slice(start, end + 1)); } catch (e) { return null; }
}

async function joinChannel(channelId) {
  try {
    const resp = await fetch('https://slack.com/api/conversations.join', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channelId })
    });
    const data = await resp.json();
    console.log('Join:', data.ok, data.error || '');
    return data.ok;
  } catch(e) {
    console.log('Join error:', e.message);
    return false;
  }
}

async function getSlackMessages() {
  try {
    const histResp = await fetch('https://slack.com/api/conversations.history?channel=' + EOD_CHANNEL + '&limit=20', {
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
    });
    const histData = await histResp.json();
    if (!histData.ok) {
      if (histData.error === 'not_in_channel') {
        await joinChannel(EOD_CHANNEL);
        const retry = await fetch('https://slack.com/api/conversations.history?channel=' + EOD_CHANNEL + '&limit=20', {
          headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
        });
        const retryData = await retry.json();
        if (!retryData.ok) return 'Slack error after join: ' + retryData.error;
        return (retryData.messages || []).slice(0, 15).map(function(m) { return m.text || ''; }).join('\n---\n');
      }
      throw new Error('Slack history error: ' + histData.error);
    }
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
    const slackMsgs = await getSlackMessages();
    const setsSheet = await getSheetCSV('1AkxdjAM884izuBY1VQpgfqdbvgUhh1YEGHsLOpSxCqE');
    const cashSheet = await getSheetCSV('1B6QTcC5elS8GSy0dszGVWMPQeDczy01i-4DDDvaQzyU');
    const prompt = 'Today is ' + today + ' EST. You are Brandon Arellano performance assistant.' +
      ' Analyze data and respond ONLY in JSON with no explanation.' +
      '\n\nSLACK messages:\n' + slackMsgs.slice(0, 3000) +
      '\n\nBrandon sets sheet (CSV):\n' + setsSheet.slice(0, 2000) +
      '\n\nCash MTD sheet (CSV):\n' + cashSheet.slice(0, 2000) +
      '\n\nExtract: closer EODs last 48h (Victor,Thomas,Luke,Joohan), Brandon sets this week, Brandon personal cash MTD, team cash MTD.' +
      ' JSON: {"week_sets":<n>,"brandon_personal_cash_mtd":<n>,"team_cash_mtd":<n>,' +
      '"closer_eods":[{"closer":"","date":"","calls":<n>,"offers":<n>,"closes":<n>,"cash_today":<n>,"cash_mtd":<n>,"brandon_leads":[]}]}';
    const data = await callClaude([{ role: 'user', content: prompt }]);
    const text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('');
    const parsed = extractJSON(text);
    if (parsed) {
      res.json({ success: true, data: parsed });
    } else {
      res.json({ success: false, error: 'Could not parse', raw: text.slice(0, 300),
        data: { week_sets: 0, brandon_personal_cash_mtd: 0, team_cash_mtd: 0, closer_eods: [] } });
    }
  } catch (err) {
    console.error('Error:', err.message);
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
  joinChannel(EOD_CHANNEL);
});

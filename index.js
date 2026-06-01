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
    console.error('Join error:', e.message);
    return false;
  }
}

async function getSlackMessages() {
  try {
    const resp = await fetch('https://slack.com/api/conversations.history?channel=' + EOD_CHANNEL + '&limit=30', {
      headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
    });
    const histData = await resp.json();
    if (!histData.ok) {
      if (histData.error === 'not_in_channel') {
        await joinChannel(EOD_CHANNEL);
        const retry = await fetch('https://slack.com/api/conversations.history?channel=' + EOD_CHANNEL + '&limit=30', {
          headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
        });
        const retryData = await retry.json();
        if (!retryData.ok) return 'Slack error after join: ' + retryData.error;
        return (retryData.messages || []).slice(0, 20).map(function(m) { return m.text || ''; }).join('\n---\n');
      }
      throw new Error('Slack history error: ' + histData.error);
    }
    return (histData.messages || []).slice(0, 20).map(function(m) { return m.text || ''; }).join('\n---\n');
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

// Calculate team_cash_mtd from closer_eods by summing ALL cash_mtd values
// (treat each EOD as a separate closer's contribution even if same name)
function calcTeamCashMTD(closerEods) {
  if (!closerEods || !closerEods.length) return 0;
  // Get unique (closer+cash_mtd) combinations to avoid double-counting exact duplicates
  const seen = new Set();
  let total = 0;
  closerEods.forEach(function(eod) {
    const key = eod.closer + ':' + eod.cash_mtd;
    if (!seen.has(key)) {
      seen.add(key);
      total += (parseFloat(eod.cash_mtd) || 0);
    }
  });
  return total;
}

app.post('/api/live-data', async function(req, res) {
  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      timeZone: 'America/New_York'
    });
    const slackMsgs = await getSlackMessages();
    const setsSheet = await getSheetCSV('1AkxdjAM884izuBY1VQpgfqdbvgUhh1YEGHsLOpSxCqE');

    const prompt = 'Today is ' + today + ' EST. You are Brandon Arellano performance assistant.' +
      ' Analyze data and respond ONLY in JSON with no explanation and no markdown.' +
      '\n\nSLACK messages:\n' + slackMsgs.slice(0, 3000) +
      '\n\nBrandon sets sheet (CSV):\n' + setsSheet.slice(0, 2000) +
      '\n\nInstructions:' +
      '\n1. Extract ALL closer EODs from the last 48 hours. Closers are Victor, Thomas, Luke, Joohan (not Brandon - he is an SDR/setter).' +
      '\n2. For each EOD include: closer full name, date, calls taken, offers made, closes made, cash today, cash MTD, and brandon_leads list.' +
      '\n3. DO NOT deduplicate EODs by name - include ALL EOD entries as separate objects even if same name.' +
      '\n4. Count Brandon sets this week from the CSV (rows where SDR Name = Brandon, date in current week).' +
      '\n5. For brandon_personal_cash_mtd: find cash data specifically attributed to Brandon (e.g. if there is a line saying Brandon cash or payment attributed to Brandon as setter). If none found return null.' +
      '\n6. Set team_cash_mtd to 0 (the server will calculate it from the EODs).' +
      '\n\nReturn ONLY this JSON (numbers not strings):' +
      '\n{"week_sets":<n>,"brandon_personal_cash_mtd":<n or null>,"team_cash_mtd":0,' +
      '"closer_eods":[{"closer":"full name","date":"YYYY-MM-DD","calls":<n>,"offers":<n>,"closes":<n>,"cash_today":<n>,"cash_mtd":<n>,"brandon_leads":[{"name":"","outcome":"","closed":<bool>}]}]}';

    const data = await callClaude([{ role: 'user', content: prompt }]);
    const text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('');
    const parsed = extractJSON(text);
    if (parsed) {
      // Override team_cash_mtd with our own calculation
      parsed.team_cash_mtd = calcTeamCashMTD(parsed.closer_eods);
      res.json({ success: true, data: parsed });
    } else {
      res.json({ success: false, error: 'Could not parse', raw: text.slice(0, 300),
        data: { week_sets: 0, brandon_personal_cash_mtd: null, team_cash_mtd: 0, closer_eods: [] } });
    }
  } catch (err) {
    console.error('Error:', err.message);
    res.json({ success: false, error: err.message,
      data: { week_sets: 0, brandon_personal_cash_mtd: null, team_cash_mtd: 0, closer_eods: [] } });
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

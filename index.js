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

app.post('/api/live-data', async function(req, res) {
  try {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      timeZone: 'America/New_York'
    });
    const slackMsgs = await getSlackMessages();
    const setsSheet = await getSheetCSV('1AkxdjAM884izuBY1VQpgfqdbvgUhh1YEGHsLOpSxCqE');

    const prompt = 'Today is ' + today + ' EST. You are Brandon Arellano performance assistant.' +
      ' Analyze data and respond ONLY in JSON with no explanation.' +
      '\n\nSLACK messages:\n' + slackMsgs.slice(0, 3000) +
      '\n\nBrandon sets sheet (CSV):\n' + setsSheet.slice(0, 2000) +
      '\n\nInstructions:' +
      '\n1. Extract closer EODs from the last 48 hours (closers are Victor, Thomas, Luke, Joohan - not Brandon).' +
      '\n2. For each EOD, extract: closer name, date, calls taken, offers made, closes made, cash today, cash MTD, and brandon_leads (leads Brandon set that appear in this EOD with outcome and whether closed).' +
      '\n3. Deduplicate: if same closer posted twice on same date, keep BOTH entries as separate EODs.' +
      '\n4. Count Brandon sets this week from the CSV sheet (rows where SDR Name = Brandon, date within current week Mon-Sun).' +
      '\n5. team_cash_mtd = sum the MOST RECENT (latest) cash_mtd from each UNIQUE closer. If Luke appears twice with different cash_mtd, use the highest value for Luke only.' +
      '\n6. brandon_personal_cash_mtd: look at ALL brandon_leads across ALL EODs where closed=true this month. This represents cash Brandon personally generated as a setter. If none found, return null.' +
      '\n\nReturn ONLY this JSON (use numbers not strings, no markdown, no backticks):' +
      '\n{"week_sets":<n>,"brandon_personal_cash_mtd":<n or null>,"team_cash_mtd":<n>,' +
      '"closer_eods":[{"closer":"","date":"YYYY-MM-DD","calls":<n>,"offers":<n>,"closes":<n>,"cash_today":<n>,"cash_mtd":<n>,"brandon_leads":[{"name":"","outcome":"","closed":<bool>}]}]}';

    const data = await callClaude([{ role: 'user', content: prompt }]);
    const text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text || ''; }).join('');
    const parsed = extractJSON(text);
    if (parsed) {
      // Post-process: calculate brandon_personal_cash_mtd from brandon_leads if null
      if (parsed.brandon_personal_cash_mtd === null && parsed.closer_eods) {
        // Count closed brandon leads across all EODs as indicator of Brandon's production
        let closedLeads = 0;
        parsed.closer_eods.forEach(function(eod) {
          if (eod.brandon_leads) {
            eod.brandon_leads.forEach(function(lead) {
              if (lead.closed) closedLeads++;
            });
          }
        });
        // If we have closed leads, note it exists but exact $ not available
        if (closedLeads > 0) {
          parsed.brandon_personal_cash_mtd = 0; // placeholder - data not in source
          parsed.brandon_closed_leads_mtd = closedLeads;
        }
      }
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

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function extractText(content) {
  if (!content || !Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text || '').join('');
}

function extractJSON(str) {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(str.slice(start, end + 1)); } catch (e) { return null; }
}

async function callClaude(messages, mcpServers) {
  if (!mcpServers) mcpServers = [];
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, mcp_servers: mcpServers, messages: messages })
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
    const mcpServers = [
      { type: 'url', url: 'https://mcp.slack.com/mcp', name: 'slack' },
      { type: 'url', url: 'https://drivemcp.googleapis.com/mcp/v1', name: 'gdrive' }
    ];
    const userPrompt = 'You are Brandon Arellano performance assistant. Today is ' + today + ' EST. ' +
      'Using connected MCP tools, pull: ' +
      '1. Slack #eod-report-for-sales-team - recent closer EODs (Victor, Thomas, Luke, Joohan) last 48h. ' +
      '2. Google Drive file 1AkxdjAM884izuBY1VQpgfqdbvgUhh1YEGHsLOpSxCqE - count Brandon sets this week. ' +
      '3. Google Drive file 1B6QTcC5elS8GSy0dszGVWMPQeDczy01i-4DDDvaQzyU - Brandon personal cash MTD May 2026 and team cash MTD May 2026. ' +
      'Respond ONLY in JSON: {"week_sets":<n>,"brandon_personal_cash_mtd":<n>,"team_cash_mtd":<n>,"closer_eods":[{"closer":"","date":"","calls":<n>,"offers":<n>,"closes":<n>,"cash_today":<n>,"cash_mtd":<n>,"brandon_leads":[]}]}';
    var messages = [{ role: 'user', content: userPrompt }];
    var data = await callClaude(messages, mcpServers);
    var attempts = 0;
    while (data.stop_reason === 'tool_use' && attempts < 10) {
      attempts++;
      var toolResults = [];
      for (var i = 0; i < data.content.length; i++) {
        if (data.content[i].type === 'tool_use') {
          toolResults.push({ type: 'tool_result', tool_use_id: data.content[i].id, content: 'OK' });
        }
      }
      messages = [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: data.content },
        { role: 'user', content: toolResults }
      ];
      data = await callClaude(messages, mcpServers);
    }
    const finalText = extractText(data.content);
    const parsed = extractJSON(finalText);
    if (parsed) {
      res.json({ success: true, data: parsed });
    } else {
      res.json({ success: false, error: 'Could not parse', raw: finalText.slice(0, 300),
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

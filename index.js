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

async function callClaude(messages, mcpServers = []) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04'
    },
    body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', max_tokens: 4000, mcp_servers: mcpServers, messages })
  });
  if (!response.ok) { const err = await response.text(); throw new Error('Anthropic API error ' + response.status + ': ' + err); }
  return response.json();
}

app.post('/api/live-data', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    const mcpServers = [
      { type: 'url', url: 'https://mcp.slack.com/mcp', name: 'slack' },
      { type: 'url', url: 'https://drivemcp.googleapis.com/mcp/v1', name: 'gdrive' }
    ];
    const systemPrompt = `You are Brandon Arellano's performance assistant. Today is ${today} EST. Respond ONLY with valid JSON, no markdown, no explanation.`;
    const userPrompt = `Pull the following data using your connected tools:

1. Search Slack #eod-report-for-sales-team for the most recent closer EODs (Victor, Thomas, Luke, Joohan) posted in the last 48 hours. For each closer EOD found, extract: closer name, date, calls taken, offers made, closes, cash collected today, MTD cash collected, and any outcomes from sets from Brandon Arellano specifically.

2. From the closer EODs, identify any leads where Setter = Brandon and summarize their outcomes.

3. Pull Brandon's sets this week from Google Drive file ID 1AkxdjAM884izuBY1VQpgfqdbvgUhh1YEGHsLOpSxCqE - count how many sets Brandon has booked this week (Monday to today).

4. From the sales tracker (Google Drive file ID 1B6QTcC5elS8GSy0dszGVWMPQeDczy01i-4DDDvaQzyU), pull Brandon's personal cash collected in May 2026 and the total team cash collected in May 2026 (setters: Brandon, Camilla, David, Dimitrije, Jad only).

Respond ONLY in this exact JSON format with no markdown, no explanation, no preamble:
{
  "week_sets": <number>,
  "brandon_personal_cash_mtd": <number>,
  "team_cash_mtd": <number>,
  "closer_eods": [
    {
      "closer": "<name>",
      "date": "<date>",
      "calls": <number>,
      "offers": <number>,
      "closes": <number>,
      "cash_today": <number>,
      "cash_mtd": <number>,
      "brandon_leads": ["<outcome1>","<outcome2>"]
    }
  ]
}`;

    let messages = [{ role: 'user', content: userPrompt }];
    let data = await callClaude(messages, mcpServers);
    let attempts = 0;

    while (data.stop_reason === 'tool_use' && attempts < 10) {
      attempts++;
      const toolResults = [];
      for (const block of data.content) {
        if (block.type === 'tool_use') {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Tool executed successfully' });
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
      res.json({ success: false, error: 'Could not parse response', raw: finalText.slice(0, 500), data: { week_sets: 0, brandon_personal_cash_mtd: 0, team_cash_mtd: 0, closer_eods: [] } });
    }
  } catch (err) {
    console.error('Error:', err);
    res.json({ success: false, error: err.message, data: { week_sets: 0, brandon_personal_cash_mtd: 0, team_cash_mtd: 0, closer_eods: [] } });
  }
});

app.get('/', (req, res) => res.json({ status: 'Brandon OS API running', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Brandon OS API running on port ' + PORT));

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
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, mcp_servers: mcpServers, messages })
  });
  if (!response.ok) { const err = await response.text(); throw new Error('Anthropic API error ' + response.status + ': ' + err); }
  return response.json();
}

app.post('/api/live-data', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    const MCP_SERVERS = [
      { type: 'url', url: 'https://mcp.slack.com/mcp', name: 'slack' },
      { type: 'url', url: 'https://drivemcp.googleapis.com/mcp/v1', name: 'gdrive' }
    ];
    const systemPrompt = "You are Brandon's performance assistant. Today is " + today + " EST. You have access to Slack and Google Drive tools. Use them to gather data, then respond with ONLY a JSON object - no markdown, no explanation, no preamble. Just the raw JSON.";
    const userPrompt = "Pull the following data using your tools:\n\n1. Search Slack channel #eod-report-for-sales-team for closer EODs from Victor, Thomas, Luke, and Joohan posted in the last 48 hours. For each EOD extract: closer name, date, calls taken, offers made, closes, cash collected today, MTD cash, and any outcomes specifically for leads where Setter = Brandon Arellano or Brandon.\n\n2. Read Google Drive file ID 1AkxdjAM884izuBY1VQpgfqdbvgUhh1YEGHsLOpSxCqE and count how many sets Brandon booked this week (Monday " + today + " to today).\n\n3. Read Google Drive file ID 1B6QTcC5elS8GSy0dszGVWMPQeDczy01i-4DDDvaQzyU and calculate: Brandon's personal cash collected in May 2026, and total team cash collected in May 2026 from setters Brandon, Camilla, David, Dimitrije, Jad only.\n\nAfter gathering all data respond with ONLY this JSON, no other text:\n{\n  \"week_sets\": 0,\n  \"brandon_personal_cash_mtd\": 0,\n  \"team_cash_mtd\": 0,\n  \"closer_eods\": [{ \"closer\": \"name\", \"date\": \"date\", \"calls\": 0, \"offers\": 0, \"closes\": 0, \"cash_today\": 0, \"cash_mtd\": 0, \"brandon_leads\": [\"outcome\"] }]\n}";
    let finalText = '';
    let attempts = 0;
    while (attempts < 10) {
      attempts++;
      const data = await callClaude([{ role: 'user', content: systemPrompt + '\n\n' + userPrompt }], MCP_SERVERS);
      const text = extractText(data.content);
      if (text) finalText = text;
      if (data.stop_reason === 'end_turn') break;
      if (data.stop_reason === 'tool_use' || data.stop_reason === 'mcp_tool_use') { await new Promise(r => setTimeout(r, 1000)); continue; }
      break;
    }
    const parsed = extractJSON(finalText);
    if (!parsed) return res.json({ success: false, error: 'Could not parse JSON', raw: finalText.slice(0, 500), data: { week_sets: 0, brandon_personal_cash_mtd: 0, team_cash_mtd: 0, closer_eods: [] } });
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: err.message, data: { week_sets: 0, brandon_personal_cash_mtd: 0, team_cash_mtd: 0, closer_eods: [] } });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Brandon OS API running', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('Brandon OS API running on port ' + PORT); });

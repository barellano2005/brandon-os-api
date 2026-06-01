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
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, mcp_servers: mcpServers, messages })
  });
  if (!response.ok) { const err = await response.text(); throw new Error('Anthropic API error ' + response.status + ': ' + err); }
  return response.json();
}


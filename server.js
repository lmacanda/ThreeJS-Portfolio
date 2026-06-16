require('dotenv').config();

const http  = require('http');
const https = require('https');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT    = 3001;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST')    { res.writeHead(405); res.end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
      },
    };

    const proxy = https.request(options, r => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });

    proxy.on('error', () => { res.writeHead(500); res.end('{}'); });
    proxy.write(body);
    proxy.end();
  });
}).listen(PORT, () => console.log(`proxy running on http://localhost:${PORT}`));
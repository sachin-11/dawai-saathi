// Mock of the WhatsApp Graph API for local load tests (M15). Accepts every send and read receipt,
// answers like Meta does ({"messages":[{"id":"wamid..."}]}) and counts what it received.
//
//   node infra/loadtest/mock-graph.js          # listens on :9999 ; GET /stats shows the counters
//   gateway: WA_API_BASE_URL=http://localhost:9999 WA_ACCESS_TOKEN=any-local-token
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const port = Number(process.env.PORT || 9999);
const stats = { sends: 0, readReceipts: 0, other: 0, failed: 0 };
// GET /fault/token makes every send fail like an expired token (Meta error 190); GET /fault/off clears it.
let fault = null;

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url && req.url.startsWith('/fault/')) {
      fault = req.url === '/fault/token' ? 'token' : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fault }));
      return;
    }
    if (req.method === 'GET' && req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }
    req.resume();
    req.on('end', () => {
      if (fault === 'token' && req.url && req.url.endsWith('/messages')) {
        stats.failed += 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url && req.url.endsWith('/messages')) {
        stats.sends += 1;
        res.end(JSON.stringify({ messages: [{ id: `wamid.mock-${randomUUID()}` }] }));
      } else {
        stats.other += 1;
        res.end(JSON.stringify({ success: true }));
      }
    });
  })
  .listen(port, () => process.stdout.write(`mock graph api on :${port}\n`));

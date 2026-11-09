// k6 smoke test (M15): 20 inbound WhatsApp messages per second for 2 minutes against a LOCAL stack
// with fake providers. It is a smoke test (does anything break, what is the reply latency), not the full
// load test (that is M18).
//
//   1. start the stack:  make up   (or the test stack) ; LLM_MODE=fake for the AI service
//   2. start the mock Graph API:   node infra/loadtest/mock-graph.js         (port 9999)
//   3. start the gateway with WA_API_BASE_URL=http://localhost:9999 and the SAME secrets as below
//   4. seed users:   pnpm --filter @dawai/gateway exec ts-node scripts/seed-loadtest-users.ts
//   5. run:  k6 run -e GATEWAY=http://localhost:3000 -e WA_APP_SECRET=<secret> infra/loadtest/smoke.js
//      (or: docker run --rm -i -e GATEWAY=http://host.docker.internal:3000 -e WA_APP_SECRET=... grafana/k6 run - < infra/loadtest/smoke.js)
//
// Reply latency itself is read from the gateway's own metric (reply_latency_ms), see docs/modules/M15.md.
// The numbers are FICTIONAL test numbers; the mock Graph API guarantees nothing is ever sent to WhatsApp.
import crypto from 'k6/crypto';
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const GATEWAY = __ENV.GATEWAY || 'http://localhost:3000';
const SECRET = __ENV.WA_APP_SECRET || 'integration-app-secret';
const PHONE_NUMBER_ID = __ENV.WA_PHONE_NUMBER_ID || '1234567890';
const USERS = Number(__ENV.USERS || 200);
const RATE = Number(__ENV.RATE || 20);
const DURATION = __ENV.DURATION || '2m';

const rejected = new Counter('webhook_rejected');

export const options = {
  scenarios: {
    inbound: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'], // no 5xx / connection errors
    http_req_duration: ['p(95)<800'], // the webhook only stores and enqueues (CLAUDE.md §10: < 1 s)
    webhook_rejected: ['count==0'],
  },
};

// A mix that exercises the AI path (text questions) and cheap commands.
const TEXTS = ['kya kar sakte ho?', 'HELP', 'Dolo 650 ka generic batao', 'MEDS', 'hi'];

export default function () {
  // __ITER is per virtual user; the scenario-wide counter spreads messages evenly over the users.
  const iteration = exec.scenario.iterationInTest;
  const n = iteration % USERS;
  const from = String(919000000000 + n); // fictional
  const wamid = `wamid.k6-${iteration}-${Date.now()}`;
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'k6',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  from,
                  id: wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: TEXTS[(iteration + Math.floor(iteration / USERS)) % TEXTS.length] },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature = 'sha256=' + crypto.hmac('sha256', SECRET, body, 'hex');
  const res = http.post(`${GATEWAY}/webhook/whatsapp`, body, {
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
  });
  const ok = check(res, { 'webhook 200': (r) => r.status === 200 });
  if (!ok) rejected.add(1);
}

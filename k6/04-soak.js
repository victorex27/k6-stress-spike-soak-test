// SOAK TEST: does it get worse over time?
//
// Normal, steady traffic for a long time. Nothing about the load changes,
// so if the API gets slower, the API changed, not the test.
//
// A real soak runs for hours. This app has two time bugs on purpose, so you
// can see them in 10 minutes. For your own API: -e DURATION=4h
//
// The trap: k6's end-of-test summary is ONE number for the whole run.
// Early fast requests and late slow requests average into "looks fine".
// So every request is tagged with the phase of the run it happened in, and
// the first and last 20% of the run get their own thresholds.
//
// Run: k6 run k6/04-soak.js
//      k6 run -e DURATION=4h -e RATE=20 k6/04-soak.js
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { BASE_URL, authHeaders, createUsers, login } from './lib/api.js';

const RATE = Number(__ENV.RATE || 10); // journeys per second, a normal day
const DURATION = __ENV.DURATION || '10m';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: RATE * 2,
      maxVUs: RATE * 10,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Same SLO at the start and at the end. A soak test fails when the end
    // can't meet what the start could.
    'http_req_duration{name:GET /users/me/activity,phase:early}': ['p(95)<50'],
    'http_req_duration{name:GET /users/me/activity,phase:late}': ['p(95)<50'],
    'http_req_duration{name:GET /items/{id},phase:early}': ['p(95)<50'],
    'http_req_duration{name:GET /items/{id},phase:late}': ['p(95)<50'],
  },
};

export function setup() {
  // A handful of busy accounts, so each one builds up a real history.
  return { users: createUsers(4) };
}

// Which part of the run are we in? progress goes from 0 to 1.
function phase() {
  const p = exec.scenario.progress;
  if (p < 0.2) return 'early';
  if (p > 0.8) return 'late';
  return 'middle';
}

// Tokens expire after 30 minutes, and a real soak runs for hours.
// Each VU keeps its own copy and logs in again when the API says 401.
const tokens = {};

function get(user, path, name) {
  const params = () => ({ headers: authHeaders(tokens[user.email]), tags: { name, phase: phase() } });
  tokens[user.email] = tokens[user.email] || user.token;
  let res = http.get(`${BASE_URL}${path}`, params());
  if (res.status === 401) {
    tokens[user.email] = login(user.email);
    res = http.get(`${BASE_URL}${path}`, params());
  }
  return res;
}

// "A normal day": open an item, change it, look at your history.
export default function ({ users }) {
  const user = users[exec.scenario.iterationInTest % users.length];

  const item = get(user, `/items/${user.itemId}`, 'GET /items/{id}');
  check(item, { 'item: 200': (r) => r.status === 200 });

  const upd = http.patch(
    `${BASE_URL}/items/${user.itemId}`,
    JSON.stringify({ quantity: Math.floor(Math.random() * 100) }),
    { headers: authHeaders(tokens[user.email]), tags: { name: 'PATCH /items/{id}', phase: phase() } },
  );
  check(upd, { 'update: 200': (r) => r.status === 200 });

  const activity = get(user, '/users/me/activity', 'GET /users/me/activity');
  check(activity, { 'activity: list returned': (r) => r.status === 200 && Array.isArray(r.json()) });

  const recent = get(user, '/users/me/recent', 'GET /users/me/recent');
  check(recent, { 'recent: has the item': (r) => r.status === 200 && r.json('0.id') === user.itemId });
}

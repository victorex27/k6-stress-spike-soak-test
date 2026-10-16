// SPIKE TEST, the version you'll find in most tutorials.
//
// Normal traffic, then the number of virtual users (VUs) jumps up for 30s,
// then drops back. Each VU opens the app, waits 1s, and repeats.
//
// Sizing: we want the spike to be ~50 journeys per second. Each journey takes
// ~0.1s plus 1s of think time, so 50 journeys/s needs about 55 VUs. That's the
// usual way people size it. Watch what actually reaches the server.
//
// Run: k6 run k6/02-spike-vus.js
//      k6 run -e SPIKE_RATE=150 k6/02-spike-vus.js   (bigger machine)
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { createUsers, openTheApp } from './lib/api.js';

const BASE_RATE = Number(__ENV.BASE_RATE || 5); // journeys per second, normal day
const SPIKE_RATE = Number(__ENV.SPIKE_RATE || 50); // journeys per second we want during the spike
const VUS_PER_RATE = 1.1; // 1s think time + ~0.1s per journey

const BASE_VUS = Math.round(BASE_RATE * VUS_PER_RATE);
const SPIKE_VUS = Math.round(SPIKE_RATE * VUS_PER_RATE);

// Count the journeys that actually start while the spike holds (40s-70s).
// We asked for SPIKE_RATE per second, so 30s should give SPIKE_RATE * 30.
const journeys = new Counter('journeys');
const inSpikeHold = () => {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  return elapsed >= 40 && elapsed < 70;
};

export const options = {
  stages: [
    { duration: '10s', target: BASE_VUS },  // warm up
    { duration: '20s', target: BASE_VUS },  // normal traffic
    { duration: '10s', target: SPIKE_VUS }, // the spike hits
    { duration: '30s', target: SPIKE_VUS }, // spike holds
    { duration: '10s', target: BASE_VUS },  // back to normal
    { duration: '30s', target: BASE_VUS },  // did it recover?
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // A spike is allowed to be slow. It isn't allowed to break: under 3s, under 1% errors.
    'http_req_duration{name:POST /auth/login}': ['p(95)<3000'],
    // Not a pass/fail rule, just a way to print the count in the summary.
    'journeys{phase:spike_hold}': ['count>=0'],
  },
};

export function setup() {
  return { users: createUsers(50) };
}

export default function ({ users }) {
  if (inSpikeHold()) journeys.add(1, { phase: 'spike_hold' });
  openTheApp(users[Math.floor(Math.random() * users.length)]);
  sleep(1);
}

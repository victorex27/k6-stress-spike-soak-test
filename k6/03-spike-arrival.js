// SPIKE TEST, done with arrival rates (an open model).
//
// Same spike as 02: 5 journeys/s, then 50 journeys/s for 30s, then back to 5.
// The difference: k6 starts a new journey on schedule whether or not the API
// has answered the previous ones. Real users do the same. They don't wait
// for someone else's login to finish before tapping "Log in".
//
// One scenario per phase, so each phase gets its own thresholds:
//   before     -> normal traffic
//   spike      -> did we survive it? (slower is OK, up to 3s per login)
//   catch_up   -> first 30s after the spike, no threshold: let the queue drain
//   recovered  -> did we get back to normal?
//
// Run: k6 run k6/03-spike-arrival.js
//      k6 run -e SPIKE_RATE=150 k6/03-spike-arrival.js   (bigger machine)
import { createUsers, openTheApp } from './lib/api.js';

const BASE_RATE = Number(__ENV.BASE_RATE || 5);
const SPIKE_RATE = Number(__ENV.SPIKE_RATE || 50);
const CATCH_UP = Number(__ENV.CATCH_UP || 30); // seconds we allow the API to work through the queue

const phase = (rate, duration, startTime) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration,
  startTime,
  preAllocatedVUs: rate,
  maxVUs: SPIKE_RATE * 10, // room for journeys that pile up while the API is slow
});

export const options = {
  scenarios: {
    before: phase(BASE_RATE, '30s', '0s'),
    spike: phase(SPIKE_RATE, '30s', '30s'),
    catch_up: phase(BASE_RATE, `${CATCH_UP}s`, '60s'),
    recovered: phase(BASE_RATE, '30s', `${60 + CATCH_UP}s`),
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:before,name:POST /auth/login}': ['p(95)<500'],
    'http_req_duration{scenario:spike,name:POST /auth/login}': ['p(95)<3000'], // slow is OK, broken isn't
    'http_req_duration{scenario:recovered,name:POST /auth/login}': ['p(95)<500'],
    // Every journey after the catch-up window must fully work.
    'checks{scenario:recovered}': ['rate>0.99'],
  },
};

export function setup() {
  return { users: createUsers(50) };
}

export default function ({ users }) {
  openTheApp(users[Math.floor(Math.random() * users.length)]);
}

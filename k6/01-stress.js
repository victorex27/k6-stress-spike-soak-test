// STRESS TEST: where does it start to hurt?
//
// Step the load up past what we expect in production and watch which step
// breaks the thresholds. Each step is its own scenario, so the end-of-test
// summary gives you a separate pass/fail line per step.
//
// "Load" here = new arrivals per second (an open model). k6 starts a new
// "open the app" journey every 1/rate seconds, even if the API is slow.
//
// Run: k6 run k6/01-stress.js
//      k6 run -e STEPS=5,10,20,40 k6/01-stress.js   (pick steps for your machine)
import { createUsers, openTheApp } from './lib/api.js';

// Journeys per second, one step every STEP_DURATION seconds.
const STEPS = (__ENV.STEPS || '10,20,40,60,80').split(',').map(Number);
const STEP_DURATION = 30; // seconds

const scenarios = {};
const thresholds = {
  http_req_failed: ['rate<0.01'],
};

STEPS.forEach((rate, i) => {
  const name = `step_${String(rate).padStart(3, '0')}_per_s`; // zero-padded so the summary sorts in order
  scenarios[name] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: `${STEP_DURATION}s`,
    startTime: `${i * STEP_DURATION}s`,
    preAllocatedVUs: rate,
    maxVUs: rate * 5,
    gracefulStop: '5s',
  };
  // One line per step in the summary: p95 of the login under this load.
  thresholds[`http_req_duration{scenario:${name},name:POST /auth/login}`] = ['p(95)<500'];
});

export const options = { scenarios, thresholds };

export function setup() {
  return { users: createUsers(50) };
}

export default function ({ users }) {
  const user = users[Math.floor(Math.random() * users.length)];
  openTheApp(user);
}

// Shared helpers for every script in this folder.
import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
export const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SuperSecret123!';

// Real apps give up long before k6's default 60s. A request that hangs past
// this counts as a failed request (status 0), so a frozen API shows up as
// errors in the results instead of as silence.
const TIMEOUT = __ENV.TIMEOUT || '10s';

// Called from setup(): create a pool of real users (each with one item)
// BEFORE the load starts, so signup cost doesn't pollute the results.
export function createUsers(count) {
  const runId = Date.now();
  const users = [];
  for (let i = 0; i < count; i++) {
    const email = `user_${runId}_${i}@example.com`;
    const signup = http.post(
      `${BASE_URL}/auth/signup`,
      JSON.stringify({ email, password: PASSWORD, full_name: `Load User ${i}` }),
      { headers: JSON_HEADERS, tags: { name: 'setup' } },
    );
    if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${signup.body}`);

    const token = login(email, 'setup');
    const item = http.post(
      `${BASE_URL}/items`,
      JSON.stringify({ name: `Item ${i}`, description: 'x'.repeat(500), price: 10, quantity: 1 }),
      { headers: authHeaders(token), tags: { name: 'setup' } },
    );
    users.push({ email, token, itemId: item.json('id') });
  }
  return users;
}

export function login(email, tagName = 'POST /auth/login') {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: JSON_HEADERS,
    tags: { name: tagName },
    timeout: TIMEOUT,
  });
  const ok = check(res, { 'login: got a token': (r) => r.status === 200 && !!r.json('access_token') });
  return ok ? res.json('access_token') : null;
}

export function authHeaders(token) {
  return { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
}

// "Someone opens the app": log in, load their profile, load their items.
// This is the journey the stress and spike tests repeat.
export function openTheApp(user) {
  const token = login(user.email);
  if (!token) return; // login failed: the check above already recorded it

  const headers = authHeaders(token);
  const me = http.get(`${BASE_URL}/users/me`, { headers, tags: { name: 'GET /users/me' }, timeout: TIMEOUT });
  check(me, { 'me: right user': (r) => r.status === 200 && r.json('email') === user.email });

  const items = http.get(`${BASE_URL}/items`, { headers, tags: { name: 'GET /items' }, timeout: TIMEOUT });
  check(items, { 'items: list returned': (r) => r.status === 200 && Array.isArray(r.json()) });
}

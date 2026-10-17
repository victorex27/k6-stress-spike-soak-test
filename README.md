# Stress vs spike vs soak test in k6: what does each one break?

Companion code for the buildwithamaobi video **"Stress vs Spike vs Soak Test in k6: What Does Each One Break?"**

One realistic API (signup, login with bcrypt, items you own), three k6 tests, three different failures:

| Test | Question it answers | Load shape | What it found in this app |
|---|---|---|---|
| **Stress** `k6/01-stress.js` | Where does it start to hurt? | Step up past normal, one step at a time | Login is CPU-bound (bcrypt). Past the ceiling it doesn't error, it queues: p95 jumps from ~0.1s to ~2s |
| **Spike** `k6/02-spike-vus.js` + `k6/03-spike-arrival.js` | Does it survive a sudden burst, and come back? | Normal → 10× for 30s → normal | With an arrival rate, the API froze for good (DB pool deadlock). The usual VU-based spike test never saw it |
| **Soak** `k6/04-soak.js` | Does it get worse over time? | Normal load, held for a long time | History endpoint slows down as rows pile up, memory climbs and never comes back |

The app has bugs **on purpose** for the soak test. They're marked `SOAK BUG` in `app/main.py` and `app/models.py`.

## Stack

- **API:** Python 3.10+, FastAPI, SQLAlchemy 2, SQLite (WAL), bcrypt, PyJWT
- **Load testing:** [k6](https://grafana.com/docs/k6/latest/) v2.x (tested with v2.3.0)
- **Manual testing:** Postman collection in `postman/`

## 1. Run the API

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

fastapi run app/main.py            # no auto-reload: use this when load testing
```

For the tests in this repo, start it with production-strength password hashing:

```bash
BCRYPT_ROUNDS=12 fastapi run app/main.py
```

Logins cost about 4x more, so a laptop hits its ceiling at the default rates in the scripts. With the default (10), a fast machine might shrug off the spike and you won't see anything break.

Open http://localhost:8000/docs for interactive Swagger docs. Endpoint reference: [docs/API.md](docs/API.md).

**Restart with a fresh database before every test** so runs are comparable: stop the server, delete `app.db*`, start it again.

## 2. Try it in Postman

Import `postman/k6-stress-spike-soak.postman_collection.json` and run it top to bottom.

## 3. Install k6

```bash
brew install k6                    # macOS
winget install k6 --source winget  # Windows
# Linux / other: https://grafana.com/docs/k6/latest/set-up/install-k6/
k6 version
```

## 4. Run the tests

```bash
# Stress: step up the load, 30s per step. Pick steps that make sense for YOUR machine.
k6 run k6/01-stress.js                         # default steps: 10,20,40,60,80 journeys/s
k6 run -e STEPS=5,10,15,20,30 k6/01-stress.js  # a small laptop / CI runner

# Spike, the common way (virtual users) and the honest way (arrival rate)
k6 run k6/02-spike-vus.js
k6 run k6/03-spike-arrival.js
k6 run -e SPIKE_RATE=150 k6/03-spike-arrival.js  # set the spike to ~2-3x your stress-test ceiling

# Soak: 10 minutes here because the bugs are fast on purpose. Real soaks run for hours.
k6 run k6/04-soak.js
k6 run -e DURATION=4h -e RATE=20 k6/04-soak.js

# Another environment:
k6 run -e BASE_URL=https://staging.example.com k6/04-soak.js

# Live charts while a test runs (http://localhost:5665), great for the spike:
K6_WEB_DASHBOARD=true k6 run k6/03-spike-arrival.js
```

Every script creates its own test users in `setup()` (emails on `example.com`), so you don't need any data first.

### Watch memory during the soak test

k6 measures the API from the outside. A memory leak shows up on the server, so watch it there:

```bash
# macOS / Linux: the API's memory (RSS) in MB every 10s
while true; do ps -o rss= -p $(pgrep -f "fastapi run") | awk '{printf "%d MB\n", $1/1024}'; sleep 10; done
```

## Things these tests taught us (the gotchas)

1. **A VU-based spike test holds back when your API slows down.** Each virtual user waits for its response before starting the next request, so when the API slows down, the load drops. We sized `02-spike-vus.js` for 50 journeys per second and, on my test machine, it delivered about 17. With enough VUs (165 in our test) the VU version froze the API too: what matters is how many requests are in flight at once, and an arrival rate is the honest way to get there. Use an arrival-rate executor (`constant-arrival-rate`, `ramping-arrival-rate`) when the question is "what if more people show up than we can handle?"
2. **A threshold with no data passes.** When the API froze, logins in the "recovered" phase never answered, k6 had no samples, and the threshold showed `p(95)=0s ✓`. Give requests a realistic timeout (`timeout: '10s'` in `k6/lib/api.js`) so a frozen API turns into failed requests instead of silence.
3. **The end-of-test summary averages away a soak problem.** Tag requests by phase of the run (`early` / `middle` / `late`) and put the same threshold on the start and the end.
4. **Stress past the ceiling looked like zero errors.** Nothing failed. Everything just got several times slower. Always put a latency threshold next to the error-rate threshold.

## The spike bug (and the fix)

The ep01 version of `app/db.py` capped SQLite at 40 connections (`pool_size=20, max_overflow=20`). FastAPI runs a plain `def` endpoint in two trips through its 40-thread pool: one to run it, one to validate the response. Between the two trips, the request still holds its database connection. Under the spike, all 40 connections ended up parked in requests waiting for a thread, while all 40 threads waited for a connection. The API never recovered, even after the traffic stopped.

The fix in this repo: SQLite connections are file handles, so `app/db.py` uses `NullPool` (no cap). With Postgres or MySQL you can't go unlimited: close the session before the endpoint returns, keep the pool bigger than everything that can be in flight, and limit concurrency in front of the app.

## Config (env vars)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./app.db` | Any SQLAlchemy URL |
| `SECRET_KEY` | dev value | **Change in any real deployment** |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | The soak test logs in again on 401 |
| `BCRYPT_ROUNDS` | `10` | Use `12` for these tests. Higher = slower login = lower stress-test ceiling |

| k6 variable | Used by | Default |
|---|---|---|
| `BASE_URL` | all | `http://localhost:8000` |
| `TIMEOUT` | all | `10s` per request |
| `STEPS` | stress | `10,20,40,60,80` journeys/s |
| `BASE_RATE`, `SPIKE_RATE`, `CATCH_UP` | spike | `5`, `50` journeys/s, `30` s |
| `RATE`, `DURATION` | soak | `10` journeys/s, `10m` |

> ⚠️ Only load test systems you own or have permission to test.

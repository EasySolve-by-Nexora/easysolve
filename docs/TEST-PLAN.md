# EasySolve test plan

Covers automated checks (what runs in CI and what the audit runs locally) and manual checks for a human tester. Use it before every release and after any change to auth, runs, billing or the worker.

Status key for manual cases: **P** pass, **F** fail, **B** blocked, **D** documented decision (see section 5).

## 1. Environments and prerequisites

| Item | Needed for | Notes |
| --- | --- | --- |
| Staging deploy of web + worker | All manual tests | Same config shape as production |
| `APP_URL` = exact HTTPS origin | CSRF, reset links | Reset links use this value |
| `TRUST_PROXY=true` behind a proxy that overwrites `X-Forwarded-For` | Auth | Production returns 503 on sign-in/sign-up/recovery without it |
| `RESEND_API_KEY` (sending-only) | Welcome and reset emails | Sender `easysolve@nexoratech.works` |
| `DEEPSEEK_API_KEY` | Chat, runs | Use a low-limit key on staging |
| Worker running + `easysolve-sandbox:local` image built | Runs | `npm run doctor` must pass |
| Two GitHub test accounts, one fine-grained token each | Sync, runs, assignments, reviews | Plus a throwaway repo where the tester has admin/maintain |
| Stellar testnet wallet with USDC trustline | Billing | Never test with mainnet |
| Two mailboxes you control (one for a known user, one unregistered) | Auth emails | |
| An admin account (bootstrapped with `npm run admin:bootstrap`) | Admin | |

Record: build commit SHA, environment, tester, date, browser/device.

## 2. Automated testing

### 2.1 What runs and when

| Layer | Command | Where | Covers |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | CI, local | Whole TypeScript project |
| Unit | `npm test` | CI, local | Pure logic: auth input, security, GitHub throttle, policy, Stellar, assignments, DeepSeek adapter, email |
| Integration | `npm run test:integration` | CI (Postgres 17 service), local (disposable container) | Auth and throttling, billing/payments, admin, allowances, queue/worker workflow, recovery, reviews, sync, sandbox (real Docker) |
| Browser | `npm run test:browser` | CI only (needs Chromium) | Sign-in, workspace screens, chat, billing, admin, CSRF/isolation, desktop + mobile |

Local integration recipe (never point it at a real database):

1. Start a throwaway Postgres: `docker run -d --name easysolve-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 127.0.0.1:55432:5432 postgres:17-alpine`
2. Export `DATABASE_URL`, `APP_URL=http://localhost:3000`, a random 32-byte base64 `TOKEN_ENCRYPTION_KEY`, `AI_PROVIDER=deepseek`, `DEEPSEEK_API_KEY=mocked`.
3. `npm run db:migrate`, `docker build -t easysolve-sandbox:local sandbox`, then run the layers above.
4. Remove the container afterwards.

Green means all of: typecheck clean, unit and integration suites pass, CI browser job passes on the PR.

### 2.2 Automated cases to keep green (regression list)

- Auth throttling: per-account limit across many IPs, per-IP limit across many accounts, case-insensitive email, no raw email in rate-limit keys, production 503 without `TRUST_PROXY`, 503 without a forwarded IP.
- Recovery: identical response for unknown, known and undeliverable accounts; per-email limit (3/hour); no global bucket; one-use link; sessions revoked.
- Runs: partial start returns 200 with `runs` and `skipped`; nothing started returns 409 with reasons; concurrent starts reserve atomically; chat confirm reports the same reasons.
- Billing: invoice creation, exact-amount verification, memo/asset/issuer checks, expiry, replay safety.
- Queue: claim locking, per-account concurrency, lease reclaim, cancel/retry.
- Signup sends at most one welcome email. Delivery is best-effort: an email
  provider failure must not roll the account back or prevent sign-up.

### 2.3 Regression coverage added in this release

The suite covers worker polling while jobs run, agent step/time limits, sync
resilience to missing issues, closed-PR issue release, check-run pagination,
case-insensitive assignment logins, and credential deletion on disconnect.
Disconnected identities deliberately retain their account slot; only an
administrator can permanently free it.

## 3. Manual test cases

Run on desktop Chrome and one phone-width viewport unless noted. Use fresh accounts for each section.

### 3.1 Sign-up and welcome email

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| A1 | Sign up with a new email | Account created, signed in, welcome email arrives from `EasySolve <easysolve@nexoratech.works>` with logo, correct name, no broken images | |
| A2 | Sign up again with the same email | Clear "already exists" error, no second email | |
| A3 | Sign up with an invalid email, short password, empty name | Field-level errors, no account | |
| A4 | Open the welcome email in Gmail and Outlook, light and dark mode | Readable, logo loads, no spam-folder landing on a clean domain | |
| A5 | Temporarily break the email key on staging, then sign up | Signup still succeeds and signs in (welcome email is best-effort); no email; server log shows the failure; restore the key | |
| A6 | Sign up while Resend is slow | Signup completes within about 3 seconds (the welcome email waits at most 3 s) | |

### 3.2 Sign-in, sessions and throttling

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| S1 | Sign in, refresh, close and reopen the tab | Session persists | |
| S2 | Wrong password 3 times, then correct | 401 with a generic message, then success | |
| S3 | Wrong password 11 times for one email within 15 minutes (from any network) | 429 "Too many requests"; the UI shows it clearly; a different email still works | |
| S4 | Try 11 different emails from one connection within a minute | 429 on the 11th; other users on other networks unaffected | |
| S5 | Log out, press Back | No private data shown | |
| S6 | Change password in Account | Other sessions end, current stays signed in | |
| S7 | Send a request to the API with a forged `X-Forwarded-For` straight to the origin (bypassing the proxy) | Rejected or ignored; limits cannot be bypassed | |
| S8 | Deploy a build without `TRUST_PROXY` in a production-mode environment | Sign-in returns 503; server log names the missing setting | |

### 3.3 Password recovery

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| R1 | Request recovery for a registered email | Message "If this account exists…"; reset email arrives (branded, correct link to `APP_URL`) | |
| R2 | Request recovery for an unregistered email | **Identical** message and similar timing; no email | |
| R3 | Click the link, set a new password | Success; old password stops working; other sessions are signed out | |
| R4 | Reuse the same link | "Recovery link expired" | |
| R5 | Wait 30+ minutes, use an unused link | Expired | |
| R6 | Request recovery 4 times for the same email within an hour | 4th returns 429; a different email still works | |
| R7 | Request two links, use the second, then try the first | First should be rejected. Today only the redeemed token is deleted, so the first still works until it expires | |
| R8 | Break the email provider on staging, request recovery | Same generic response; server log shows the failure; no usable link stored | |
| R9 | Check the email's link target and footer | Exact HTTPS origin, no `undefined`, no tracking redirect | |

### 3.4 GitHub identities and sync

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| G1 | Connect a valid token | Identity shows connected with the right login | |
| G2 | Connect an invalid/expired token | Clear credential error, no identity | |
| G3 | On Basic (limit 1), connect A, disconnect A, connect B | B is refused until an administrator removes A (D8). By design: users cannot self-remove | D |
| G4 | After disconnecting, check the database | Stored token is empty; re-enabling it without a new token is refused (409) | |
| G5 | Assign yourself an issue on GitHub, press Sync | Issue appears with correct title, labels, assignees | |
| G6 | Close the issue on GitHub, sync | Marked done; reopen it, sync | Issue becomes ready again | |
| G7 | Lose access to a repo with a previously synced issue, then sync | Sync still completes for everything else | |
| G8 | Hit the GitHub rate limit (or simulate) | Job pauses and resumes at the recorded reset time; no identity-switch bypass | |

### 3.5 Runs

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| U1 | Start one run on a small issue (approval mode) | Queued, runs, reaches awaiting review with diff, tests and logs | |
| U2 | Approve and publish | PR opened from a fork or branch with the run marker; `Closes #n` present | |
| U3 | Start in plan mode | Plan produced, nothing published, issue returns to ready | |
| U4 | Select 4 issues in one repo with "group" | One run, one job counted | |
| U5 | Select more issues than the allowance | HTTP 200, partial start; UI says N queued, M skipped | |
| U6 | Exhaust the allowance, then start again | 409 with reasons (issue allowance or monthly job limit); toast shows the reason | |
| U7 | Ask chat to start a run and confirm when allowance is exhausted | Error with reasons, not "Action completed" | |
| U8 | Cancel while running | Run cancelled, issues back to ready, sandbox container removed | |
| U9 | Close the PR on GitHub without merging, sync | Issues become startable again | |
| U10 | Kill the worker mid-run and restart it | Lease expires, run restarts cleanly, no duplicate PR | |
| U11 | Give an issue the agent cannot solve | Run ends as blocked by `AGENT_MAX_SECONDS` (default 25 min) or `AGENT_MAX_STEPS` (default 40), with a clear message and retry available | |
| U12 | Start two runs from two users at once | Both progress; neither waits for the other to finish | |

### 3.6 Chat, assignments, reviews

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| C1 | Ask a plain question | Streamed answer, saved in history after refresh | |
| C2 | Have 50+ long issues, then ask about issues | Reply, no "narrow the context" error | |
| C3 | Break the provider key, send a message | Inline sanitized error, text preserved, retry keeps the same ID | |
| M1 | Propose assignments with a mixed-case username | Applies and shows applied | |
| M2 | Apply a proposal whose issue was assigned meanwhile | That entry fails with a reason, others apply | |
| V1 | Open the review queue for a repo with a PR that has 30+ check runs, one failing late | PR is **not** shown as ready | |
| V2 | Merge a ready PR | Squash merge at the reviewed SHA, runs credited | |
| V3 | Push a new commit, then try to merge using the old view | Rejected: head changed | |

### 3.7 Billing and entitlements (testnet only)

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| B1 | Create an invoice, pay the exact amount with the memo | Pro activates after verification | |
| B2 | Pay too little, too much, wrong asset, wrong memo, after expiry | Never activates; shown as underpaid, overpaid, unmatched or expired | |
| B3 | Submit the same transaction hash twice | No double credit | |
| B4 | Pro expiry / lifetime rules | Limits fall back to Basic as configured | |
| B5 | Wallet watcher after a short Horizon outage | Resumes without manual action | |

### 3.8 Admin and security

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| D1 | Non-admin opens `/admin` and `/api/admin/*` | Denied | |
| D2 | Suspend a user | Sessions revoked, runs cancelled, login blocked; audit entry written | |
| D3 | Change a user's plan limits | Audited; chat respects the token limit | |
| D4 | Delete a user | Requires typing the email; admin/owner protected; receipts retained | |
| D5 | Send a state-changing request without the right `Origin` | 403 | |
| D6 | Request another user's run, repository or conversation by ID | 404/403 | |
| D8 | As admin, permanently remove a user's GitHub identity (reason required) | Credential deleted, slot freed, audit entry written; refused while runs are queued or running; user with published or awaiting-review runs keeps a working review queue and allowance | |
| D9 | As a non-admin, call `POST /api/admin/users/:id/identities/:id/delete` | 403 | |
| D7 | Check responses and logs | No tokens, keys or raw emails in errors or logs | |

### 3.9 Operations

| ID | Steps | Expected | Result |
| --- | --- | --- | --- |
| O1 | `npm run doctor` on staging | All green, including trusted proxy | |
| O2 | `GET /api/health` | 200 with database check | |
| O3 | Restart web and worker during traffic | No lost jobs; heartbeats resume | |
| O4 | Check stopped sandbox containers after a worker crash | None accumulate | |

## 4. Execution order

1. Automated: typecheck, unit, integration locally; wait for CI browser job on the PR.
2. Manual smoke (30 min): A1, S1, S3, R1, R3, G1, G5, U1, U2, U6, D1.
3. Full manual pass: sections 3.1 to 3.9.
4. Re-test every **K** item after its fix lands and mark it P or F.

## 5. Resolved in this release (retest) and decisions

Resolved, covered by automated tests, and worth one manual pass: worker keeps claiming jobs while others run (U12); agent step and time ceilings (U11); validation guard (only real test runners count; the last one must pass); sync survives a gone issue, frees issues after a closed PR, revives reopened issues (G6, G7, U9); paginated check runs and single-PR merge validation (V1); repo stats for large repositories; case-insensitive assignment logins (M1); disconnect wipes the token (G4); identity removal refused while runs are published or awaiting review (D8); every outstanding reset link revoked on redeem or password change (R7); payment watcher keeps retrying (B5); bounded chat context (C2) and bootstrap payload; new indexes.

Decisions to keep in mind:
- D: only administrators can free a GitHub identity slot (G3, D8).
- Run-scoped AI calls are not limited by the per-account `planMaxTokens`; use suspension or the run ceilings to stop spend.
- The CSP still allows inline scripts (needed by the framework without a nonce setup).
- Provider "verified" in the admin view expires after 24 idle hours; it is informational only.

## 6. Exit criteria

- All automated layers green on the release commit.
- Every manual case is P, or K with a linked issue and an agreed decision to ship.
- No open High item unless the owner explicitly accepts the risk in writing.
- Production checklist done: `TRUST_PROXY=true`, `APP_URL`, `RESEND_API_KEY`, backups, `npm run doctor` green.

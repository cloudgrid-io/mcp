// Offline unit test for the grid_login sign-in poller (issue #306).
//
// Claim under test: after "Open sign-in", the card polls grid_login_status on a
// bounded loop that ALWAYS terminates — it stops on success, stops at a
// wall-clock ceiling, and stops after a run of consecutive errors — and it does
// nothing at all before it is started. Proving termination is the whole point:
// a card left open in a background tab must never sit hitting our API forever.
//
// The loop lives in src/widgets/grid-login/poller.js with every timing and
// environment dependency injected, so this test drives it with a fake clock and
// a fake scheduler and observes exactly how many round-trips it makes and when
// it quits — no real time passes, no DOM, no network.
//
// Blind spot (stated plainly): this exercises the pure loop, not the real
// browser wiring in mcp-app.js (setTimeout/performance.now/document.hidden/the
// App round-trip). That the wiring reaches signed-in state with no click is
// proven separately against the ext-apps basic-host render harness — a unit test
// cannot show the user-visible outcome.
// Run: node test/login-poller.test.mjs

import { createPoller } from "../src/widgets/grid-login/poller.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A deterministic clock + scheduler. schedule() records pending callbacks keyed
// by fire-time; tickTo(t) advances the clock and fires everything due, awaiting
// each so async check() bodies settle before the next event. This is a faithful
// stand-in for setTimeout/performance.now because the poller only ever asks
// "what time is it?" and "run this in intervalMs".
function makeClock() {
  let nowMs = 0;
  let seq = 0;
  const pending = new Map(); // id -> { at, fn }
  return {
    now: () => nowMs,
    schedule: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: nowMs + ms, fn });
      return id;
    },
    cancel: (id) => pending.delete(id),
    async tickTo(target) {
      // Fire due callbacks in time order until we reach `target`. Each callback
      // may schedule the next tick, so we loop until nothing is due.
      for (;;) {
        let next = null;
        for (const [id, item] of pending) {
          if (item.at <= target && (next === null || item.at < next.at)) {
            next = { id, ...item };
          }
        }
        if (!next) break;
        nowMs = next.at;
        pending.delete(next.id);
        await next.fn();
      }
      nowMs = target;
    },
    pendingCount: () => pending.size,
  };
}

const INTERVAL = 3000;
const CEILING = 150000;
const MAX_ERR = 3;

// ── 1. Never polls before start() ─────────────────────────────────────────────
{
  const clock = makeClock();
  let checks = 0;
  createPoller({
    intervalMs: INTERVAL, ceilingMs: CEILING, maxConsecutiveErrors: MAX_ERR,
    check: async () => { checks++; return { authenticated: false, errored: false }; },
    onSuccess: () => {}, onCeiling: () => {}, onGiveUp: () => {},
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel, isHidden: () => false,
  });
  await clock.tickTo(CEILING * 2);
  check("untouched poller makes zero round-trips and schedules nothing",
    checks === 0 && clock.pendingCount() === 0);
}

// ── 2. Stops at the wall-clock ceiling (the core termination proof) ───────────
{
  const clock = makeClock();
  let checks = 0;
  let ceilingHit = false;
  const p = createPoller({
    intervalMs: INTERVAL, ceilingMs: CEILING, maxConsecutiveErrors: MAX_ERR,
    check: async () => { checks++; return { authenticated: false, errored: false }; }, // never signs in
    onSuccess: () => {}, onCeiling: () => { ceilingHit = true; }, onGiveUp: () => {},
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel, isHidden: () => false,
  });
  p.start();
  // Run far PAST the ceiling. If the loop were unbounded it would keep scheduling
  // forever and pendingCount would stay 1; termination means it goes to 0.
  await clock.tickTo(CEILING * 100);
  check("ceiling: onCeiling fired", ceilingHit);
  check("ceiling: loop stopped — no timer left pending", clock.pendingCount() === 0);
  // A never-signing-in card is capped: with a 3s interval under a 150s ceiling,
  // it can issue at most 50 round-trips, and then it is done.
  check(`ceiling: bounded round-trips (${checks} ≤ ${CEILING / INTERVAL})`,
    checks > 0 && checks <= CEILING / INTERVAL);
  check("ceiling: does not resume after stopping", p.isStopped() === false && (await (async () => {
    const before = checks; await clock.tickTo(CEILING * 200); return checks === before;
  })()));
}

// ── 3. Stops on success, and only success calls onSuccess ─────────────────────
{
  const clock = makeClock();
  let checks = 0;
  let signedInEmail = "unset";
  const p = createPoller({
    intervalMs: INTERVAL, ceilingMs: CEILING, maxConsecutiveErrors: MAX_ERR,
    // unauthenticated twice, then authenticated
    check: async () => {
      checks++;
      if (checks < 3) return { authenticated: false, errored: false };
      return { authenticated: true, email: "michal@atomiclabs.io", errored: false };
    },
    onSuccess: (email) => { signedInEmail = email; },
    onCeiling: () => {}, onGiveUp: () => {},
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel, isHidden: () => false,
  });
  p.start();
  await clock.tickTo(CEILING);
  check("success: onSuccess got the email", signedInEmail === "michal@atomiclabs.io");
  check("success: stopped after 3 polls, no more", checks === 3 && clock.pendingCount() === 0);
  check("success: isStopped() is permanent", p.isStopped() === true);
  const before = checks;
  await clock.tickTo(CEILING * 10);
  check("success: no polling after signed in", checks === before);
}

// ── 4. Stops after MAX_CONSECUTIVE_ERRORS in a row ────────────────────────────
{
  const clock = makeClock();
  let checks = 0;
  let gaveUp = false;
  const p = createPoller({
    intervalMs: INTERVAL, ceilingMs: CEILING, maxConsecutiveErrors: MAX_ERR,
    check: async () => { checks++; return { authenticated: false, errored: true }; },
    onSuccess: () => {}, onCeiling: () => {}, onGiveUp: () => { gaveUp = true; },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel, isHidden: () => false,
  });
  p.start();
  await clock.tickTo(CEILING);
  check("errors: onGiveUp fired", gaveUp);
  check("errors: stopped exactly at the error cap", checks === MAX_ERR && clock.pendingCount() === 0);
}

// ── 5. A transient error does NOT trip the cap (counter resets on success) ─────
{
  const clock = makeClock();
  let checks = 0;
  let gaveUp = false;
  let signedIn = false;
  const script = [
    { errored: true }, { errored: true }, // 2 errors (cap is 3)
    { errored: false, authenticated: false }, // recovers → resets counter
    { errored: true }, { errored: true }, // 2 more errors — must NOT give up
    { authenticated: true, email: "a@b.co", errored: false },
  ];
  const p = createPoller({
    intervalMs: INTERVAL, ceilingMs: CEILING, maxConsecutiveErrors: MAX_ERR,
    check: async () => script[checks++] ?? { authenticated: false, errored: false },
    onSuccess: () => { signedIn = true; }, onCeiling: () => {}, onGiveUp: () => { gaveUp = true; },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel, isHidden: () => false,
  });
  p.start();
  await clock.tickTo(CEILING);
  check("transient errors: never gave up (counter reset on recovery)", gaveUp === false);
  check("transient errors: reached signed-in", signedIn === true);
}

// ── 6. Hidden tab skips the round-trip but the ceiling still terminates ────────
{
  const clock = makeClock();
  let checks = 0;
  let ceilingHit = false;
  const p = createPoller({
    intervalMs: INTERVAL, ceilingMs: CEILING, maxConsecutiveErrors: MAX_ERR,
    check: async () => { checks++; return { authenticated: false, errored: false }; },
    onSuccess: () => {}, onCeiling: () => { ceilingHit = true; }, onGiveUp: () => {},
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    isHidden: () => true, // tab hidden the whole time
  });
  p.start();
  await clock.tickTo(CEILING * 100);
  check("hidden: made zero round-trips while hidden", checks === 0);
  check("hidden: still hit the ceiling and stopped", ceilingHit && clock.pendingCount() === 0);
}

console.log(failures ? `\n${failures} FAIL` : "\nAll grid_login poller checks passed.");
process.exit(failures ? 1 : 0);

/**
 * @file Bounded sign-in poller for the grid_login MCP App (issue #306).
 *
 * After the user clicks "Open sign-in", the browser (not the card) performs the
 * auth, and the card has no way to be told when it finishes — so it polls
 * grid_login_status. Every poll is a real round-trip to our API, so this loop is
 * bounded three independent ways and NEVER runs before it is started:
 *
 *   • interval  — at most one check every `intervalMs` (never a tight loop)
 *   • ceiling   — gives up after `ceilingMs` of wall-clock, whatever happens
 *   • errors    — stops after `maxConsecutiveErrors` failed round-trips in a row
 *
 * While the tab is hidden it skips the round-trip (the wall-clock ceiling still
 * applies, so it always terminates). A card left open in a background tab can
 * therefore issue at most ceiling/interval requests and then stops for good.
 *
 * Every timing/environment dependency is injected so the loop is testable with
 * fake timers and a fake clock, with no DOM and no ext-apps import. mcp-app.js
 * wires the real `setTimeout`, `performance.now`, `document.hidden`, and the
 * grid_login_status round-trip into it. This whole module is bundled inline into
 * src/widgets/grid-login.html by scripts/build-login-widget.mjs.
 */

/**
 * @param {object} deps
 * @param {number} deps.intervalMs            delay between polls
 * @param {number} deps.ceilingMs             wall-clock budget before giving up
 * @param {number} deps.maxConsecutiveErrors  errors in a row before giving up
 * @param {() => Promise<{authenticated: boolean, email?: string|null, errored: boolean}>} deps.check
 *        one grid_login_status round-trip, reduced to a plain outcome
 * @param {(email: string|null|undefined) => (void|Promise<void>)} deps.onSuccess
 *        called once when authenticated; the poller stops permanently first
 * @param {() => void} deps.onCeiling         called when the wall-clock ceiling is hit
 * @param {() => void} deps.onGiveUp          called when consecutive errors hit the cap
 * @param {() => number} [deps.now]           monotonic clock (defaults to performance.now)
 * @param {(fn: Function, ms: number) => any} [deps.schedule]  defaults to setTimeout
 * @param {(handle: any) => void} [deps.cancel]                defaults to clearTimeout
 * @param {() => boolean} [deps.isHidden]     whether to skip a round-trip this tick
 */
export function createPoller({
  intervalMs,
  ceilingMs,
  maxConsecutiveErrors,
  check,
  onSuccess,
  onCeiling,
  onGiveUp,
  now = () => performance.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  isHidden = () => typeof document !== "undefined" && document.hidden,
}) {
  let timer = null;
  let deadline = 0;
  let consecutiveErrors = 0;
  let stopped = false; // permanent once we succeed; blocks any further work

  function armNext() {
    timer = schedule(tick, intervalMs);
  }

  function start() {
    // Idempotent: a manual re-check that resumes polling won't stack loops, and
    // it cannot restart once we've succeeded.
    if (stopped || timer !== null) return;
    deadline = now() + ceilingMs;
    consecutiveErrors = 0;
    armNext();
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    if (now() >= deadline) {
      onCeiling(); // ceiling: stop; caller keeps the manual fallback on screen
      return;
    }
    if (isHidden()) {
      armNext(); // don't spend a round-trip while hidden; ceiling still applies
      return;
    }
    const outcome = await check();
    if (stopped) return;
    if (outcome.authenticated) {
      stopped = true;
      await onSuccess(outcome.email);
      return;
    }
    if (outcome.errored) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        onGiveUp(); // terminal failure: stop, keep the manual path
        return;
      }
    } else {
      consecutiveErrors = 0;
    }
    armNext();
  }

  return { start, stop, isStopped: () => stopped };
}

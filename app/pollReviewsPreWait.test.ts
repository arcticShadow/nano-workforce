// Behavioral regression for issue #920: a review on the CURRENT head that was submitted BEFORE the
// row entered `waiting_review` must still resume the loop.
//
// `waiting_since` is stamped by `pr.progress-check` at the END of a round (after review-round →
// adversarial-review → persist-round → check-progress). The old freshness predicate required
// `submitted_at >= waiting_since`, so a review that landed in either window below was excluded
// forever — the head never moves again, no later review arrives, and the wait could only end via the
// `wait-review-timeout` escalation, paging a human about a review that is already on the PR:
//   1. DURING the round — the agent pushes, a fast reviewer reviews that head while the agent is still
//      wrapping up (adversarial pass, result write).
//   2. BEFORE the loop started — a review already on the current head when `submitPr` (re)opens it.
//
// Freshness is now keyed off what the review JUDGES, not the moment the row flipped: unconsumed
// (`id > last_review_id`) and of the current head (`isReviewStale`, #799). The negative controls pin
// that those two guards still hold, and that the stranded merge→convergence handoff row (which the
// time fence used to shield) is still never correlated.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import { READINESS_READY_MESSAGE } from "./readiness.ts";
import { pollReviews, selectFreshReview } from "./service.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
}

const REPO = "owner/repo";
const NUMBER = 17;
const HEAD_REF = "feat/x";
const HEAD = "SHA_HEAD";

type Review = { id: number; state: string; submitted_at: string; commit_id: string };

/** Stub the token transport: the paged reviews list, the PR object (head ref + open state), the
 *  atomic branch ref the shared head reader prefers, and the requested-reviewers nudge endpoints. */
function reviewFetch(reviews: Review[], posts: string[]) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      );
    if (u.includes(`/pulls/${NUMBER}/requested_reviewers`)) {
      if (method !== "GET") {
        posts.push(`${method} ${u}`);
        return json({}, 201);
      }
      return json({ users: [] });
    }
    if (u.includes(`/pulls/${NUMBER}/reviews`)) return json(reviews);
    if (u.includes(`/git/ref/heads/${HEAD_REF}`)) return json({ object: { sha: HEAD } });
    if (u.endsWith(`/pulls/${NUMBER}`)) {
      return json({
        state: "open",
        merged: false,
        head: { ref: HEAD_REF, sha: HEAD, repo: { full_name: REPO } },
        base: { ref: "main" },
      });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

function makeEngine() {
  const published: Array<{ name: string; correlationKey: string }> = [];
  const engine = {
    publishMessage: (m: { name: string; correlationKey: string }) => {
      published.push({ name: m.name, correlationKey: m.correlationKey });
      return Promise.resolve();
    },
  } as any;
  return { engine, published };
}

function withTokenTransport<T>(run: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "test-token";
  return run().finally(() => {
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
    else delete process.env["GITHUB_TOKEN"];
  });
}

function prRow(over: Record<string, unknown> = {}) {
  return {
    pr_key: `${REPO}#${NUMBER}`,
    repo: REPO,
    number: NUMBER,
    status: "waiting_review",
    last_review_id: 0,
    // The wait opened at the END of the round (progress-check's park).
    waiting_since: "2026-11-03T03:22:48Z",
    // A recent nudge so a non-correlating pass doesn't POST — keeps the fetch stub minimal.
    last_nudge_at: new Date().toISOString(),
    process_key: "2854",
    retire_pending_key: null,
    updated_at: "t0",
    ...over,
  };
}

async function runPoll(row: Record<string, unknown>, reviews: Review[]) {
  const stores: Record<string, { rows: unknown[]; key: string }> = {
    pull_requests: { rows: [row], key: "pr_key" },
  };
  const data = {
    table: withTrackingViews((name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
    ),
  } as any;
  const { engine, published } = makeEngine();
  const posts: string[] = [];
  const prevFetch = globalThis.fetch;
  await withTokenTransport(async () => {
    globalThis.fetch = reviewFetch(reviews, posts) as typeof fetch;
    try {
      await pollReviews(data, engine, "test-token");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
  return { published, posts };
}

test("#920 case 1: a current-head review submitted DURING the round (before waiting_since) resumes the loop", async () => {
  // lighthousenz/scraps#17: wait opened 03:22:48Z, claude[bot] reviewed the current head at 03:11:49Z.
  const row = prRow();
  const { published } = await runPoll(row, [
    { id: 41, state: "COMMENTED", submitted_at: "2026-11-03T03:11:49Z", commit_id: HEAD },
  ]);
  assertEquals(published.length, 1, "readiness-ready is published — the review is already on the head");
  assertEquals(published[0]?.name, READINESS_READY_MESSAGE);
  assertEquals(published[0]?.correlationKey, `${REPO}#${NUMBER}`);
  assertEquals(row.last_review_id, 41, "last_review_id advances to the consumed review");
  assertEquals(row.status, "converging", "the loop resumes instead of waiting for the timeout");
});

test("#920 case 2: a current-head review that predates the convergence loop resumes the loop", async () => {
  // lighthousenz/scraps#23: review at 20:59:06Z, the fresh run (last_review_id reset by submitPr)
  // parked at 21:38:11Z without moving the head.
  const row = prRow({ last_review_id: null, waiting_since: "2026-11-04T21:38:11Z" });
  const { published } = await runPoll(row, [
    { id: 77, state: "COMMENTED", submitted_at: "2026-11-04T20:59:06Z", commit_id: HEAD },
  ]);
  assertEquals(published.length, 1, "readiness-ready is published for the pre-loop review");
  assertEquals(row.last_review_id, 77);
  assertEquals(row.status, "converging");
});

test("#920 control: an already-consumed review (id <= last_review_id) is NOT re-correlated", async () => {
  const row = prRow({ last_review_id: 41 });
  const { published } = await runPoll(row, [
    { id: 40, state: "COMMENTED", submitted_at: "2026-11-03T03:00:00Z", commit_id: HEAD },
    { id: 41, state: "COMMENTED", submitted_at: "2026-11-03T03:11:49Z", commit_id: HEAD },
  ]);
  assertEquals(published.length, 0, "no signal for a review the loop already consumed");
  assertEquals(row.last_review_id, 41);
  assertEquals(row.status, "waiting_review");
});

test("#920 control: a pre-wait review of a SUPERSEDED head is NOT correlated", async () => {
  const row = prRow();
  const { published } = await runPoll(row, [
    { id: 42, state: "COMMENTED", submitted_at: "2026-11-03T03:11:49Z", commit_id: "SHA_OLD" },
  ]);
  assertEquals(published.length, 0, "a stale-head review never resumes the loop (#799)");
  assertEquals(row.last_review_id, 0);
  assertEquals(row.status, "waiting_review");
});

test("#920 control: a row stranded mid merge→convergence handoff (owned by the retiring merge loop) is NOT correlated", async () => {
  // `handoffWaitingMergeToConvergence` stages `waiting_review` + `retire_pending_key = <merge key>`
  // while the row's `process_key` still names the merge instance; a crash before `submitPr` strands
  // it there. No convergence loop is parked on `wait-review`, and flipping the row to `converging`
  // would push it outside the handoff's re-drive allowlist. The old `waiting_since` time fence only
  // shielded pre-handoff reviews; ownership is the structural guard.
  const row = prRow({ process_key: "9001", retire_pending_key: "9001" });
  const { published } = await runPoll(row, [
    { id: 50, state: "COMMENTED", submitted_at: "2026-11-03T03:30:00Z", commit_id: HEAD },
  ]);
  assertEquals(published.length, 0, "no readiness-ready for a row no convergence loop owns");
  assertEquals(row.last_review_id, 0, "last_review_id untouched");
  assertEquals(row.status, "waiting_review", "the row stays at the handoff stage for the recovery pass");
});

test("selectFreshReview: the newest unconsumed review wins, independent of submission time vs the wait start", () => {
  const reviews = [
    { id: 3, submitted_at: "2026-01-01T00:00:03Z" },
    { id: 9, submitted_at: "2026-01-01T00:00:01Z" },
    { id: 5, submitted_at: "2026-01-01T00:00:02Z" },
    { id: 11, submitted_at: null },
  ];
  assertEquals(selectFreshReview(reviews, 0)?.id, 9);
  assertEquals(selectFreshReview(reviews, 9), undefined, "nothing past the consumed cursor");
  assertEquals(selectFreshReview(reviews, null)?.id, 9, "a reset cursor (fresh run) treats every submitted review as unconsumed");
  assertEquals(selectFreshReview([{ id: 11, submitted_at: null }], 0), undefined, "a pending (unsubmitted) review is never fresh");
});

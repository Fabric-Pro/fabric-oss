/**
 * Advisor Stop in the middle of a multi-index Databricks knowledge search,
 * end to end through the real vector-search client and HTTP client, with
 * only the database and the network stubbed.
 *
 * A search over several indexes is many physical requests: metadata, one
 * query per index (five at a time), and retries. A single turn check before
 * the search let every one of them go out after a Stop was recorded, and the
 * search returned its chunks as a success. Now each search request is checked
 * against the turn, the requests in flight are aborted by the first refusal,
 * and the activity rejects with the stop. The Stop here is only recorded in
 * the turn record: Temporal never delivers a cancellation.
 */

import { __resetDatabricksVectorSearchCachesForTests } from "@repo/integrations/databricks-vector-search";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	fetchCredentials: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	checkConversationTurnDispatchable: mocks.checkDispatchable,
	fetchCredentialsByIdInTenant: mocks.fetchCredentials,
}));

import { TurnDispatchActivityInboundInterceptor } from "../../../lib/turn-dispatch-interceptor";
import { isTurnNotDispatchable } from "../../orchestrator/turn-dispatch";
import {
	type ExecuteDatabricksKnowledgeSearchActivityInput,
	executeDatabricksKnowledgeSearchActivity,
} from "../databricks-knowledge";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const WORKSPACE_ORIGIN = "https://adb-1234567890123456.7.azuredatabricks.net";

const INDEXES = Array.from({ length: 8 }, (_, i) => `main.docs.index_${i}`);

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

let stopped: boolean;
let posts: string[];
let postsAfterStop: string[];
let abortedPosts: number;

/** The workspace: answers token, index-metadata and query requests. */
async function workspace(input: string | URL | Request, init?: RequestInit) {
	const url = String(input);
	if (url.endsWith("/oidc/v1/token")) {
		return jsonResponse({
			access_token: "example-token",
			expires_in: 3600,
		});
	}
	if (init?.method === "POST") {
		posts.push(url);
		if (stopped) {
			postsAfterStop.push(url);
		}
		// The user presses Stop while the first search request is running;
		// it is recorded in the turn record only.
		stopped = true;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 40);
			init.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				abortedPosts += 1;
				reject(init.signal?.reason);
			});
		});
		return jsonResponse({
			manifest: {
				columns: [{ name: "id" }, { name: "text" }, { name: "score" }],
			},
			result: { data_array: [["1", "launch plan", 0.9]] },
		});
	}
	// Index metadata, staggered so the indexes reach their search request
	// one after another.
	const index = Number(url.match(/index_(\d+)/)?.[1] ?? 0);
	await new Promise((resolve) => setTimeout(resolve, index * 5));
	return jsonResponse({
		primary_key: "id",
		status: { ready: true },
		delta_sync_index_spec: { embedding_source_columns: [{ name: "text" }] },
	});
}

const INPUT: ExecuteDatabricksKnowledgeSearchActivityInput = {
	binding: { integrationId: "integration-1", indexNames: INDEXES },
	args: { query: "launch plan" },
	userId: TURN_SCOPE.userId,
	organizationId: TURN_SCOPE.organizationId,
	turnScope: TURN_SCOPE,
};

/** Runs the activity the way the worker does: through the interceptor. */
function runActivity(input: ExecuteDatabricksKnowledgeSearchActivityInput) {
	return new MockActivityEnvironment().run(() =>
		new TurnDispatchActivityInboundInterceptor().execute(
			{ args: [input], headers: {} } as never,
			() => executeDatabricksKnowledgeSearchActivity(input),
		),
	);
}

beforeEach(() => {
	__resetDatabricksVectorSearchCachesForTests();
	stopped = false;
	posts = [];
	postsAfterStop = [];
	abortedPosts = 0;
	mocks.fetchCredentials.mockResolvedValue({
		DATABRICKS_HOST: WORKSPACE_ORIGIN,
		DATABRICKS_CLIENT_ID: "example-client",
		DATABRICKS_CLIENT_SECRET: "example-secret",
	});
	mocks.checkDispatchable.mockImplementation(async () =>
		stopped ? { ok: false, reason: "cancelled" } : { ok: true },
	);
	vi.stubGlobal("fetch", vi.fn(workspace));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a Stop recorded during a multi-index Databricks search", () => {
	it("sends no search request after the stop, aborts the one in flight and rejects with the stop", async () => {
		const outcome = await runActivity(INPUT).then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);

		expect("result" in outcome).toBe(false);
		expect(
			isTurnNotDispatchable((outcome as { error: unknown }).error),
		).toBe(true);
		expect(posts.length).toBeGreaterThan(0);
		expect(postsAfterStop).toEqual([]);
		expect(abortedPosts).toBe(posts.length);
	});

	it("searches every index as before when the turn is not stopped", async () => {
		mocks.checkDispatchable.mockResolvedValue({ ok: true });

		const result = (await runActivity(INPUT)) as Awaited<
			ReturnType<typeof executeDatabricksKnowledgeSearchActivity>
		>;

		expect(posts).toHaveLength(INDEXES.length);
		expect(result.chunks.length).toBeGreaterThan(0);
		expect(result.failures).toEqual([]);
	});
});

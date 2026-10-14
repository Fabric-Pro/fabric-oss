/**
 * The GitHub tools send no write once the Advisor chat turn they run in has
 * stopped. `executeGitHubTool` awaits its integration lookup (and a token
 * refresh, or a retry after a 401) before the tool's write, so the check at
 * the tool call's call site leaves those awaits in between. The write's own
 * POST checks the turn immediately before it is sent.
 */

import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	stopped: false,
	findFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { workflowIntegration: { findFirst: h.findFirst } },
}));
vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value,
	encryptApiKey: (value: string) => value,
}));

import { executeGitHubTool } from "../../src/github";

const STOP = new Error("the chat turn stopped");

const guard: DispatchGuard = {
	key: "turn-example-1",
	assertDispatchable: async () => undefined,
	abortSignal: () => undefined,
	rethrowIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
	throwIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
};

const sent: Array<{ url: string; method: string }> = [];

beforeEach(() => {
	h.stopped = false;
	sent.length = 0;
	// The integration lookup; the turn stops while it runs.
	h.findFirst.mockImplementation(async () => {
		await Promise.resolve();
		return {
			id: "integration-example-1",
			credentials: "gho_example_token",
			settings: null,
		};
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			sent.push({ url, method: init?.method ?? "GET" });
			return new Response(
				JSON.stringify({
					number: 7,
					html_url: "https://github.com/example-org/example/issues/7",
					title: "Saved searches",
					state: "open",
				}),
				{
					status: 201,
					headers: { "content-type": "application/json" },
				},
			);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const createIssue = () =>
	executeGitHubTool(
		"create_issue",
		{ owner: "example-org", repo: "example", title: "Saved searches" },
		"user-example-1",
		"org-example-1",
	);

describe("a GitHub write inside a chat turn", () => {
	it("is sent when nothing stops the turn", async () => {
		await runWithDispatchGuard(guard, createIssue);
		expect(sent).toEqual([
			{
				url: "https://api.github.com/repos/example-org/example/issues",
				method: "POST",
			},
		]);
	});

	it("is not sent when the turn stops during the integration lookup, and fails with the stop", async () => {
		h.findFirst.mockImplementationOnce(async () => {
			await Promise.resolve();
			h.stopped = true;
			return {
				id: "integration-example-1",
				credentials: "gho_example_token",
				settings: null,
			};
		});
		await expect(runWithDispatchGuard(guard, createIssue)).rejects.toBe(
			STOP,
		);
		expect(sent).toEqual([]);
	});

	it("is sent as before outside a chat turn", async () => {
		await createIssue();
		expect(sent).toHaveLength(1);
	});
});

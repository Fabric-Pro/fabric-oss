/**
 * A Direct chat turn stops when its client goes away.
 *
 * Direct chat cannot be reattached to, so Stop (which aborts the fetch) and a
 * closed page both end the turn: the route cancels the workflow, which stops
 * the model call. Before this, the stream's `cancel()` only stopped polling
 * and the workflow ran on to completion, spending, with nobody reading it.
 *
 * Runs the real route with its Temporal, database, auth and rate-limit
 * modules mocked.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";

const getSessionMock = vi.fn();
const startWorkflowMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: vi.fn(async () => ({
		allowed: true,
		remaining: 19,
		resetInSeconds: 60,
	})),
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60_000 } },
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(async () => ({ trackUsage: vi.fn() })),
	getCurrentDateContext: () => "Today is 2026-10-05.",
}));

vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	decodeHeartbeatDetails: vi.fn(() => undefined),
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: startWorkflowMock },
	})),
	isTemporalAvailable: vi.fn(async () => true),
}));

vi.mock("@repo/database", () => ({
	db: { agentConversation: { findFirst: vi.fn(async () => null) } },
	hasOrganizationTie: vi.fn(async () => true),
	isFeatureEnabled: vi.fn(async () => false),
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	getProjectAccessContext: vi.fn(async () => null),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const ORGANIZATION_ID = "example-org";

const loadRoute = () => import("../../app/api/agents/fabric-ai/stream/route");

type FakeHandle = {
	workflowId: string;
	status: string;
	cancel: ReturnType<typeof vi.fn>;
	describe: () => Promise<{ status: { name: string } }>;
	result: () => Promise<unknown>;
	query: () => Promise<unknown>;
};

function fakeHandle(status: string): FakeHandle {
	const handle: FakeHandle = {
		workflowId: "direct-chat-test",
		status,
		cancel: vi.fn(async () => undefined),
		describe: async () => ({ status: { name: handle.status } }),
		result: async () => ({
			success: true,
			responseText: "ok",
			toolCalls: [],
		}),
		query: async () => ({ phase: "streaming", toolCalls: [] }),
	};
	return handle;
}

async function post(signal: AbortSignal) {
	const { POST } = await loadRoute();
	return POST({
		json: async () => ({
			message: "Summarise the roadmap",
			organizationId: ORGANIZATION_ID,
		}),
		signal,
	} as never);
}

/** Reads SSE frames until one carries `type`, or the stream ends. */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	type: string,
): Promise<boolean> {
	const decoder = new TextDecoder();
	let buffered = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return false;
		}
		buffered += decoder.decode(value, { stream: true });
		if (buffered.includes(`"type":"${type}"`)) {
			return true;
		}
	}
}

describe("POST fabric-ai/stream — the client going away cancels the turn", () => {
	beforeAll(async () => {
		await loadRoute();
	}, 120_000);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "debug").mockImplementation(() => undefined);
		getSessionMock.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: ORGANIZATION_ID },
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("cancels the workflow when the client cancels the response stream", async () => {
		const handle = fakeHandle("RUNNING");
		startWorkflowMock.mockResolvedValue(handle);

		const response = await post(new AbortController().signal);
		const reader = (
			response.body as ReadableStream<Uint8Array>
		).getReader();
		expect(await readUntil(reader, "started")).toBe(true);

		await reader.cancel();

		await vi.waitFor(() => expect(handle.cancel).toHaveBeenCalledTimes(1));
	});

	it("cancels the workflow once when the request is aborted, even if the stream is cancelled too", async () => {
		const handle = fakeHandle("RUNNING");
		startWorkflowMock.mockResolvedValue(handle);
		const client = new AbortController();

		const response = await post(client.signal);
		const reader = (
			response.body as ReadableStream<Uint8Array>
		).getReader();
		expect(await readUntil(reader, "started")).toBe(true);

		client.abort();
		await reader.cancel();

		await vi.waitFor(() => expect(handle.cancel).toHaveBeenCalled());
		// Let the poll loop notice the close and finish.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(handle.cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels a workflow whose start was still in flight when the client left", async () => {
		const handle = fakeHandle("RUNNING");
		const client = new AbortController();
		let finishStart: (value: FakeHandle) => void = () => undefined;
		startWorkflowMock.mockImplementation(
			() =>
				new Promise<FakeHandle>((resolve) => {
					finishStart = resolve;
				}),
		);

		const response = await post(client.signal);
		await vi.waitFor(() => expect(startWorkflowMock).toHaveBeenCalled());
		client.abort();
		expect(handle.cancel).not.toHaveBeenCalled();
		finishStart(handle);

		await vi.waitFor(() => expect(handle.cancel).toHaveBeenCalledTimes(1));
		await response.text();
	});

	it("does not start a workflow for a client that already left", async () => {
		const client = new AbortController();
		client.abort();

		const response = await post(client.signal);
		await response.text();

		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("does not cancel a workflow that completed, even when the client leaves afterwards", async () => {
		const handle = fakeHandle("COMPLETED");
		startWorkflowMock.mockResolvedValue(handle);
		const client = new AbortController();

		const response = await post(client.signal);
		const body = await response.text();
		expect(body).toContain('"type":"done"');

		client.abort();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(handle.cancel).not.toHaveBeenCalled();
	});
});

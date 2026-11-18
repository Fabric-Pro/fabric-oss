/** Deadlines, cancellation provenance, and safe errors through the Teams request path. */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Hoisted: vi.mock factories run before module-level consts are initialized.
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@repo/database", async () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: (
		await import(
			"@repo/database/prisma/queries/workflows/integration-access"
		)
	).workflowIntegrationAccessWhere,
	resolveWorkflowIntegrationForProvider: async (
		...args: Parameters<
			typeof import("@repo/database/prisma/queries/workflows/integration-access").resolveWorkflowIntegrationForProvider
		>
	) => {
		const mocked = await import("@repo/database");
		return mocked.db.workflowIntegration.findFirst({
			where: {
				...mocked.workflowIntegrationAccessWhere(args[1], args[2]),
				provider: args[0],
				isActive: true,
			},
		});
	},
	db: { workflowIntegration: { findFirst, update: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));
vi.mock("@repo/ai", () => ({ extractRelevantExcerpts: vi.fn() }));

import { GRAPH_REQUEST_TIMEOUT_MS } from "../config/limits";
import { executeMicrosoftTeamsTool } from "../index";
import { MicrosoftRequestTimeoutError, microsoftFetch } from "../request";

beforeEach(() => {
	vi.useFakeTimers();
	// Node uses native timers here; bridge the deadline to Vitest fake timers.
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(
			() =>
				controller.abort(new DOMException("Deadline", "TimeoutError")),
			ms,
		);
		return controller.signal;
	});
	findFirst.mockResolvedValue({
		id: "example-integration",
		credentials: JSON.stringify({
			access_token: "example-token",
			refresh_token: "example-refresh",
		}),
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () =>
						reject(options.signal.reason),
					);
				}),
		),
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("bounds a hung Graph attempt without retrying", async () => {
	const result = executeMicrosoftTeamsTool(
		"get_chat_messages",
		{ chatId: "example-chat" },
		"example-user",
	);
	const assertion = expect(result).rejects.toThrow(
		"Microsoft Graph request timed out: GET /v1.0/me/chats/example-chat/messages",
	);
	await vi.advanceTimersByTimeAsync(GRAPH_REQUEST_TIMEOUT_MS);
	await assertion;
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("bounds token refresh", async () => {
	vi.stubEnv("MICROSOFT_GRAPH_CLIENT_ID", "example-client");
	vi.stubEnv("MICROSOFT_GRAPH_CLIENT_SECRET", "example-secret");
	vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 401 }));
	const result = executeMicrosoftTeamsTool(
		"get_chat_messages",
		{ chatId: "example-chat" },
		"example-user",
	);
	const assertion = expect(result).rejects.toThrow(
		"Microsoft identity request timed out: POST /common/oauth2/v2.0/token",
	);
	await vi.advanceTimersByTimeAsync(GRAPH_REQUEST_TIMEOUT_MS);
	await assertion;
});
it("preserves caller abort even when its reason is TimeoutError", async () => {
	const caller = new AbortController();
	const reason = new DOMException("Caller deadline", "TimeoutError");
	const result = microsoftFetch(
		"https://graph.microsoft.com/v1.0/me?secret=example",
		{ signal: caller.signal },
	);
	const assertion = expect(result).rejects.toBe(reason);
	caller.abort(reason);
	await assertion;
});
it("omits query strings from timeout errors", async () => {
	const result = microsoftFetch(
		"https://graph.microsoft.com/v1.0/me?secret=example",
	);
	const assertion = expect(result).rejects.toThrow(
		/^Microsoft Graph request timed out: GET \/v1.0\/me$/,
	);
	await vi.advanceTimersByTimeAsync(GRAPH_REQUEST_TIMEOUT_MS);
	await assertion;
});

it("preserves timeout when refreshing an empty stored access token", async () => {
	vi.stubEnv("MICROSOFT_GRAPH_CLIENT_ID", "example-client");
	vi.stubEnv("MICROSOFT_GRAPH_CLIENT_SECRET", "example-secret");
	findFirst.mockResolvedValue({
		id: "example-empty-integration",
		credentials: JSON.stringify({
			access_token: "",
			refresh_token: "example-refresh",
		}),
	});
	const result = executeMicrosoftTeamsTool(
		"get_chat_messages",
		{ chatId: "example-chat" },
		"example-user",
	);
	const assertion = expect(result).rejects.toMatchObject({
		constructor: MicrosoftRequestTimeoutError,
		message:
			"Microsoft identity request timed out: POST /common/oauth2/v2.0/token",
	});
	await vi.advanceTimersByTimeAsync(GRAPH_REQUEST_TIMEOUT_MS);
	await assertion;
});

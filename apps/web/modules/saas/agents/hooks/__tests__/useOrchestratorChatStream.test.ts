/**
 * Which transport the Orchestrator chat runs over: the Direct chat's rule
 * (`useRuntimeEligible`) under its own flag. `COPILOTKIT_ORCHESTRATOR_CHAT`
 * off keeps every chat on the Orchestrator stream route; on, a member whose
 * role may save conversations runs over the agent runtime, and anyone the
 * runtime would refuse stays on the stream route. The choice is fixed when
 * the chat mounts.
 *
 * Both hooks are real; `fetch` records where the turn went.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
	flag: false,
	userRole: "member" as string | null,
	isGuest: false,
	organizationId: "org_example" as string | null,
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COPILOTKIT_ORCHESTRATOR_CHAT" && access.flag,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: access.organizationId,
		userRole: access.userRole,
		isGuest: access.isGuest,
	}),
}));
vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));
vi.mock("../useOrchestratorPartyKit", () => ({
	useOrchestratorPartyKit: () => ({
		isConnected: false,
		toolCalls: [],
		stepProgress: undefined,
		currentPhase: "idle",
		reset: vi.fn(),
		notifyStepStart: vi.fn(),
	}),
}));

import { useOrchestratorChatStream } from "../useOrchestratorChatStream";

const LEGACY_URL = "/api/agents/fabric-ai/orchestrator-temporal/stream";
const RUNTIME_URL = "/api/agents/runtime/agent/fabric-orchestrator/run";

const urls: string[] = [];

/** The stream route's terminal event, or a finished runtime run. */
function sse(url: string, body: { threadId?: string; runId?: string }) {
	const events = url.startsWith("/api/agents/runtime")
		? [
				{
					type: "RUN_STARTED",
					threadId: body.threadId,
					runId: body.runId,
				},
				{
					type: "RUN_FINISHED",
					threadId: body.threadId,
					runId: body.runId,
					result: { status: "completed", response: "ok" },
					outcome: { type: "success" },
				},
			]
		: [{ type: "completed", status: "completed", response: "ok" }];
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

beforeEach(() => {
	urls.length = 0;
	access.flag = false;
	access.userRole = "member";
	access.isGuest = false;
	access.organizationId = "org_example";
	vi.spyOn(global, "fetch").mockImplementation((async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		urls.push(String(input));
		return sse(String(input), JSON.parse(String(init?.body ?? "{}")));
	}) as typeof fetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function sendOnce(organizationId: string | undefined = "org_example") {
	const { result } = renderHook(() =>
		useOrchestratorChatStream({ organizationId }),
	);
	await act(async () => {
		await result.current.sendMessage("hello");
	});
	return result.current.transport;
}

describe("useOrchestratorChatStream", () => {
	it("stays on the Orchestrator stream route while the flag is off", async () => {
		expect(await sendOnce()).toBe("legacy");
		expect(urls).toEqual([LEGACY_URL]);
	});

	it("runs over the agent runtime for a member when the flag is on", async () => {
		access.flag = true;

		expect(await sendOnce()).toBe("runtime");
		expect(urls).toEqual([RUNTIME_URL]);
	});

	it.each([
		["a project guest", { isGuest: true, userRole: null }],
		["a viewer", { isGuest: false, userRole: "viewer" }],
		[
			"a viewer whose role has not loaded",
			{ isGuest: false, userRole: null },
		],
	])(
		"keeps %s on the Orchestrator stream route with the flag on",
		async (_, who) => {
			access.flag = true;
			access.isGuest = who.isGuest;
			access.userRole = who.userRole;

			expect(await sendOnce()).toBe("legacy");
			expect(urls).toEqual([LEGACY_URL]);
		},
	);

	it("keeps a chat bound to another organization than the one on screen on the stream route", async () => {
		access.flag = true;

		expect(await sendOnce("org_other")).toBe("legacy");
		expect(urls).toEqual([LEGACY_URL]);
	});

	it("keeps the transport it mounted with when the flag changes", async () => {
		const { result, rerender } = renderHook(() =>
			useOrchestratorChatStream({ organizationId: "org_example" }),
		);
		access.flag = true;
		rerender();

		expect(result.current.transport).toBe("legacy");
		await act(async () => {
			await result.current.sendMessage("hello");
		});
		expect(urls).toEqual([LEGACY_URL]);
	});
});

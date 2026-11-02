/**
 * Which transport Deep Research runs over. `COPILOTKIT_RESEARCH_RUNS` off
 * keeps every run on the stream route; on, a member whose role may save
 * conversations runs over the agent runtime, and anyone the runtime would
 * refuse (a project guest, a viewer, a role not loaded yet) stays on the
 * stream route. Only the deep-researcher template has a runtime agent. The
 * choice is fixed when the page mounts.
 *
 * Both hooks are real; `fetch` records where the run went.
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
		key === "COPILOTKIT_RESEARCH_RUNS" && access.flag,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: access.organizationId,
		userRole: access.userRole,
		isGuest: access.isGuest,
	}),
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => vi.fn(),
}));

import { useResearchRunStream } from "../useResearchRunStream";

const LEGACY_URL = "/api/agents/workflow-templates/stream";
const RUNTIME_URL = "/api/agents/runtime/agent/deep-researcher/run";

const urls: string[] = [];

/** The stream route's completed run, or a finished runtime run for the run's ids. */
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
					outcome: { type: "success" },
				},
			]
		: [
				{
					type: "completed",
					status: "completed",
					iterations: 1,
					goalAchieved: true,
					duration: 10,
				},
			];
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
	vi.spyOn(global, "fetch").mockImplementation(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			urls.push(String(input));
			return sse(String(input), JSON.parse(String(init?.body ?? "{}")));
		},
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function renderSelector(templateSlug = "deep-researcher") {
	return renderHook(() =>
		useResearchRunStream({ templateSlug, organizationId: "org_example" }),
	);
}

async function sendOnce(templateSlug = "deep-researcher") {
	const { result } = renderSelector(templateSlug);
	await act(async () => {
		await result.current.sendQuery("What changed?");
	});
	return result.current.transport;
}

describe("useResearchRunStream", () => {
	it("stays on the stream route while the flag is off", async () => {
		expect(await sendOnce()).toBe("legacy");
		expect(urls).toEqual([LEGACY_URL]);
		expect(urls.some((url) => url.startsWith("/api/agents/runtime"))).toBe(
			false,
		);
	});

	it("runs over the agent runtime for a member when the flag is on", async () => {
		access.flag = true;

		expect(await sendOnce()).toBe("runtime");
		expect(urls).toEqual([RUNTIME_URL]);
	});

	it.each([
		["a project guest", { isGuest: true, userRole: null }],
		["a viewer", { isGuest: false, userRole: "viewer" }],
		["a role that has not loaded", { isGuest: false, userRole: null }],
	])("keeps %s on the stream route with the flag on", async (_, who) => {
		access.flag = true;
		access.isGuest = who.isGuest;
		access.userRole = who.userRole;

		expect(await sendOnce()).toBe("legacy");
		expect(urls).toEqual([LEGACY_URL]);
	});

	it("a templateSlug other than deep-researcher stays legacy with the flag on", async () => {
		access.flag = true;

		expect(await sendOnce("another-template")).toBe("legacy");
		expect(urls).toEqual([LEGACY_URL]);
	});

	it("an off-to-on flip after mount stays on the stream route", async () => {
		const { result, rerender } = renderSelector();
		access.flag = true;
		rerender();

		expect(result.current.transport).toBe("legacy");
		await act(async () => {
			await result.current.sendQuery("What changed?");
		});
		expect(urls).toEqual([LEGACY_URL]);
	});

	it("an on-to-off flip after mount stays on the runtime and keeps posting to the runtime run URL", async () => {
		access.flag = true;
		const { result, rerender } = renderSelector();
		access.flag = false;
		rerender();

		expect(result.current.transport).toBe("runtime");
		await act(async () => {
			await result.current.sendQuery("What changed?");
		});
		expect(urls).toEqual([RUNTIME_URL]);
	});

	it("reports resultRestored false on the stream route", () => {
		expect(renderSelector().result.current.resultRestored).toBe(false);
	});
});

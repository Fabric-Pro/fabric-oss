import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	activities: {} as Record<string, (...args: unknown[]) => unknown>,
	handlers: new Map<string, () => unknown>(),
	calls: [] as string[],
}));
vi.mock("@temporalio/workflow", () => ({
	defineQuery: (name: string) => name,
	defineSignal: (name: string) => name,
	setHandler: (name: string, handler: () => unknown) =>
		h.handlers.set(name, handler),
	proxyActivities: () =>
		new Proxy(
			{},
			{
				get:
					(_, name: string) =>
					async (...args: unknown[]) => {
						h.calls.push(name);
						return h.activities[name]?.(...args);
					},
			},
		),
	patched: () => false,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	workflowInfo: () => ({ workflowId: "example-workflow" }),
	CancellationScope: { nonCancellable: (fn: () => unknown) => fn() },
	ApplicationFailure: {
		nonRetryable: (message: string) => new Error(message),
	},
}));

import {
	analysisProgressQuery,
	backlogContextAnalysisWorkflow,
} from "../backlog-context-analysis-workflow";

beforeEach(() => {
	h.calls = [];
	h.handlers.clear();
	h.activities = {
		retrieveProjectRagContext: vi.fn(async () => ({ success: false })),
		fetchBacklogSnapshot: vi.fn(async () => ({
			epics: [],
			orphanFeatures: [],
			orphanStories: [],
		})),
		analyzeContextAndPropose: vi.fn(async () => ({
			summary: "Example",
			changes: [],
		})),
	};
});

describe("AI Update PM context note", () => {
	it.each([
		["failed", "fizzy", "credentials", "credentials were refused"],
		[
			"failed",
			"azure-devops",
			"other",
			"Couldn't read your Azure DevOps board",
		],
		["failed", undefined, "other", "Couldn't read your PM board"],
		["throw", undefined, "403 secret-token", "credentials were refused"],
		[
			"throw",
			undefined,
			"timeout secret-token",
			"Couldn't read your PM board",
		],
		["no-columns", "fizzy", undefined, "Cards in triage aren't included"],
		["ok", "fizzy", undefined, undefined],
		[
			"truncated",
			"github",
			undefined,
			"Only 2 items on your board were read, so AI Update may not see the rest.",
		],
		[undefined, "fizzy", undefined, undefined],
	])(
		"%s (%s, %s) continues and carries a safe note",
		async (readStatus, detectedType, readError, expected) => {
			h.activities.fetchPMWorkItemsByType = vi.fn(async () => {
				if (readStatus === "throw") {
					throw new Error("Activity failed", {
						cause: new Error(readError),
					});
				}
				return {
					epics: [],
					features: [],
					stories:
						readStatus === "truncated"
							? [{ id: "42" }, { id: "43" }]
							: [],
					readStatus: readStatus === "truncated" ? "ok" : readStatus,
					listingTruncated:
						readStatus === "truncated" ? true : undefined,
					detectedType,
					readErrorKind: readError,
				};
			});
			const result = await backlogContextAnalysisWorkflow({
				projectId: "example-project",
				userId: "example-user",
				organizationId: "example-org",
				contextSources: { fetchTeamsMessages: false },
				userPrompt: "Example update",
				pmConfig: {
					mcpConfigId: "example-config",
					containerId: "example-board",
				},
			});
			expect(h.activities.fetchPMWorkItemsByType).toHaveBeenCalledWith(
				expect.objectContaining({ forPrompt: true }),
			);
			expect(result.success).toBe(true);
			const progress = h.handlers.get(
				analysisProgressQuery as unknown as string,
			)?.() as { pmContextNote?: string };
			if (expected) {
				expect(result.pmContextNote).toContain(expected);
				expect(progress.pmContextNote).toBe(result.pmContextNote);
				expect(result.pmContextNote).not.toContain("secret-token");
			} else {
				expect(result.pmContextNote).toBeUndefined();
				expect(progress.pmContextNote).toBeUndefined();
			}
			expect(h.calls).toEqual([
				"retrieveProjectRagContext",
				"fetchBacklogSnapshot",
				"fetchPMWorkItemsByType",
				"analyzeContextAndPropose",
			]);
		},
	);
});

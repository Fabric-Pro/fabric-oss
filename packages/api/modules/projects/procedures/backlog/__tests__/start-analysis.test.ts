import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Re-export the real `GATEWAY_PROVIDERS` constant (imported transitively by
// `@repo/ai` when the input schema's module graph is loaded) so the dynamic
// model selector can construct its `Set<AIProvider>` at import time.
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return { ...actual, db: {} };
});
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../../../../orpc/procedures", () => ({
	Permissions: { PROJECT_UPDATE: "PROJECT_UPDATE" },
	requireProjectPermission: vi.fn(() => vi.fn()),
	resolveOrganizationId: vi.fn(),
	tenantProtectedProcedure: {
		use: vi.fn().mockReturnThis(),
		route: vi.fn().mockReturnThis(),
		input: vi.fn().mockReturnThis(),
		handler: vi.fn().mockReturnThis(),
	},
}));

import { startAnalysisInputSchema } from "../start-analysis";

describe("startAnalysisInputSchema", () => {
	const base = {
		projectId: "p1",
		contextSources: { fetchTeamsMessages: false },
		userPrompt: "analyze please",
	};

	it("accepts the existing shape without the new fields", () => {
		const parsed = startAnalysisInputSchema.parse(base);
		expect(parsed.contextSources.daysBack).toBeUndefined();
	});

	it("accepts selectedChannelContextIds as an array of strings", () => {
		const parsed = startAnalysisInputSchema.parse({
			...base,
			contextSources: {
				fetchTeamsMessages: false,
				selectedChannelContextIds: ["ctx-1", "ctx-2"],
			},
		});
		expect(parsed.contextSources.selectedChannelContextIds).toEqual([
			"ctx-1",
			"ctx-2",
		]);
	});

	it("accepts daysBack when it is 7, 14, 30, 60, or 90", () => {
		for (const days of [7, 14, 30, 60, 90] as const) {
			expect(() =>
				startAnalysisInputSchema.parse({
					...base,
					contextSources: {
						fetchTeamsMessages: false,
						daysBack: days,
					},
				}),
			).not.toThrow();
		}
	});

	it("rejects daysBack values outside the allowed set", () => {
		expect(() =>
			startAnalysisInputSchema.parse({
				...base,
				contextSources: { fetchTeamsMessages: false, daysBack: 15 },
			}),
		).toThrow(z.ZodError);
	});

	it("leaves daysBack undefined when omitted so legacy callers keep their pre-branch unfiltered fetch", () => {
		const parsed = startAnalysisInputSchema.parse({
			...base,
			contextSources: { fetchTeamsMessages: true },
		});
		expect(parsed.contextSources.daysBack).toBeUndefined();
	});
});

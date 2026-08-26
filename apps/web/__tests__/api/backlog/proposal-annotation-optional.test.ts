/**
 * The analyzer may legitimately return a change with no `reasoning` and no
 * `sourceContext` — both are narrative annotation, and as of the 18 Aug 2026
 * fix the generation schema in `analyze-context.ts` accepts their absence
 * rather than throwing away the whole model response over one missing sentence.
 *
 * That fix is only half a fix if the APPLY side still demands them: the failure
 * would simply move from "the run dies" to "the user reviews a proposal, clicks
 * Apply, and gets a validation error" — later, and after wasted review effort.
 *
 * These tests pin the three schemas a proposal has to survive on its way to
 * being applied. `sourceContext` matters twice over here, because the apply
 * schemas narrow it to an enum the generation schema never enforced.
 *
 * Run with:
 *   pnpm --filter @repo/web test __tests__/api/backlog/proposal-annotation-optional.test.ts
 */

import { applyChangesProcedure } from "@repo/api/modules/projects/procedures/backlog/apply-changes";
import { approvePendingProposalProcedure as approveSlackProposalProcedure } from "@repo/api/modules/projects/procedures/slack-channel-monitor/approve-pending-proposal";
import { approvePendingProposalProcedure as approveTeamsProposalProcedure } from "@repo/api/modules/projects/procedures/teams-channel-monitor/approve-pending-proposal";
import { describe, expect, it } from "vitest";

/** oRPC keeps the validated input schema on the procedure itself. */
function inputSchemaOf(procedure: unknown) {
	const schema = (procedure as { "~orpc": { inputSchema: unknown } })["~orpc"]
		.inputSchema as {
		safeParse: (v: unknown) => { success: boolean; error?: unknown };
	};
	if (!schema?.safeParse) {
		throw new Error("procedure has no parseable input schema");
	}
	return schema;
}

/** Drop keys without binding an unused name for each one. */
function omit(source: Record<string, unknown>, ...keys: string[]) {
	const copy = { ...source };
	for (const key of keys) {
		delete copy[key];
	}
	return copy;
}

/** A change carrying only what applying it genuinely requires. */
function change(overrides: Record<string, unknown> = {}) {
	return {
		type: "feature",
		action: "create",
		title: { to: "Add a retry to the ingest worker" },
		reasoning: "The meeting called out repeated ingest timeouts.",
		sourceContext: "meeting_transcript",
		...overrides,
	};
}

function applyInput(changeOverrides: Record<string, unknown> = {}) {
	return {
		projectId: "proj_1",
		approvedChanges: [change(changeOverrides)],
	};
}

describe("backlog.applyChanges input", () => {
	it("accepts an approved change whose reasoning is absent", () => {
		const result = inputSchemaOf(applyChangesProcedure).safeParse({
			projectId: "proj_1",
			approvedChanges: [omit(change(), "reasoning")],
		});

		expect(result.success).toBe(true);
	});

	it("accepts an approved change whose reasoning is null", () => {
		const result = inputSchemaOf(applyChangesProcedure).safeParse(
			applyInput({ reasoning: null }),
		);

		expect(result.success).toBe(true);
	});

	it("accepts an approved change whose sourceContext is absent", () => {
		const result = inputSchemaOf(applyChangesProcedure).safeParse({
			projectId: "proj_1",
			approvedChanges: [omit(change(), "sourceContext")],
		});

		expect(result.success).toBe(true);
	});

	it("still rejects a sourceContext outside the known set", () => {
		const result = inputSchemaOf(applyChangesProcedure).safeParse(
			applyInput({ sourceContext: "carrier_pigeon" }),
		);

		expect(result.success).toBe(false);
	});
});

describe("channel-monitor approve input", () => {
	it("accepts a Teams proposal whose annotation is absent", () => {
		const result = inputSchemaOf(approveTeamsProposalProcedure).safeParse({
			projectId: "proj_1",
			proposalId: "prop_1",
			approvedChanges: [omit(change(), "reasoning", "sourceContext")],
		});

		expect(result.success).toBe(true);
	});

	it("accepts a Slack proposal whose annotation is absent", () => {
		const result = inputSchemaOf(approveSlackProposalProcedure).safeParse({
			projectId: "proj_1",
			proposalId: "prop_1",
			approvedChanges: [omit(change(), "reasoning", "sourceContext")],
		});

		expect(result.success).toBe(true);
	});
});

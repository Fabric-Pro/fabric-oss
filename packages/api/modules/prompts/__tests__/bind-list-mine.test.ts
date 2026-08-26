/**
 * prompts.bind.listMine — "My Overrides" (Fizzy #2068 F8).
 *
 * The procedure is a thin read over listMyPromptOverrides, so what is worth
 * pinning is exactly the two things a thin read can still get wrong:
 *
 *  1. The userId reaching the query is the SESSION user, never anything the
 *     request carried — the same rule as every USER surface here.
 *  2. The action label is human text: a known agent resolves through the
 *     action catalog, and an unknown targetKey still degrades to the
 *     document-type label rather than undefined.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/bind-list-mine.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMyPromptOverrides } = vi.hoisted(() => ({
	listMyPromptOverrides: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	listMyPromptOverrides,
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	requireOrganizationAdmin: vi.fn(),
	resolveOrganizationId: (input: string | null | undefined) => input ?? null,
	tenantProtectedProcedure: (() => {
		// Permissive builder: every link returns itself, so it does not matter
		// which of route/input/output a procedure chains.
		const link: Record<string, unknown> = {};
		for (const key of ["use", "route", "input", "output"]) {
			link[key] = () => link;
		}
		link.handler = (fn: unknown) => fn;
		return link;
	})(),
}));

import { bindProcedures } from "../procedures/bind";

const call = (contextUser: { id: string }, input?: Record<string, unknown>) =>
	(bindProcedures.listMine as unknown as (a: unknown) => Promise<unknown>)({
		input: input ?? {},
		context: { user: contextUser },
	});

beforeEach(() => {
	listMyPromptOverrides.mockReset();
	listMyPromptOverrides.mockResolvedValue([]);
});

describe("prompts.bind.listMine", () => {
	it("scopes the query to the session user, ignoring any request id", async () => {
		// A request carrying someone else's userId must not redirect the read.
		await call({ id: "session-user" }, { userId: "attacker-user" });

		expect(listMyPromptOverrides).toHaveBeenCalledWith({
			userId: "session-user",
		});
	});

	it("maps a known agent to the full action label", async () => {
		listMyPromptOverrides.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				promptVersionId: "pv-1",
				updatedAt: "2026-08-24T00:00:00.000Z",
				promptVersion: {
					prompt: { id: "p-1", name: "My drafter" },
				},
			},
		]);

		const rows = (await call({ id: "session-user" })) as Array<{
			actionLabel: string;
			promptName: string;
		}>;

		expect(rows).toHaveLength(1);
		expect(rows[0].promptName).toBe("My drafter");
		expect(rows[0].actionLabel).toContain("Test Case");
	});

	it("degrades the label to the document type for an unknown agent", async () => {
		listMyPromptOverrides.mockResolvedValue([
			{
				targetKey: "not_in_catalog",
				documentType: "CLEAN_SPEC",
				storyKind: null,
				promptVersionId: "pv-2",
				updatedAt: "2026-08-24T00:00:00.000Z",
				promptVersion: {
					prompt: { id: "p-2", name: "Orphan binding" },
				},
			},
		]);

		const rows = (await call({ id: "session-user" })) as Array<{
			actionLabel: string;
		}>;

		expect(rows[0].actionLabel).toBeTruthy();
		expect(rows[0].actionLabel).not.toContain("undefined");
	});
});

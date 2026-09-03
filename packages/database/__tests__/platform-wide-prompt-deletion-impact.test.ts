/**
 * What a SYSTEM prompt deletion would remove, counted across the whole
 * platform (Fizzy #2328, R5/R6/R14).
 *
 * The warning is only worth showing if it counts the same rows the cascade
 * takes. Three ways it could quietly under-report, each pinned below:
 *
 *   - by filtering `targetType: "AGENT"` — the filter its sibling
 *     `listActionsForPrompt` carries and this query must not, because the
 *     cascade removes FEATURE / WORKFLOW / DOCUMENT bindings too;
 *   - by asking about one VERSION instead of the prompt — a binding on an
 *     older version dies with the prompt just the same;
 *   - by looking at only the SELECTED row when duplicate SYSTEM keys are
 *     legal, leaving the sibling row's bindings out of a figure the operator
 *     is about to act on.
 *
 * The fourth property is what it must NOT do: name a tenant. The result is
 * counts and display labels, never an organization or user id.
 *
 * The Prisma mock below is a small fake rather than a stub, so "counted" means
 * the row actually reached the total through a WHERE the query built — a stub
 * returning a fixed array would pass even if the traversal were wrong.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/platform-wide-prompt-deletion-impact.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type PromptRow = { id: string; key: string; scope: string };
type VersionRow = { id: string; promptId: string };
type BindingRow = {
	promptVersionId: string;
	targetType: string;
	documentType: string;
	organizationId: string | null;
	userId: string | null;
};

const fixture: {
	prompts: PromptRow[];
	versions: VersionRow[];
	bindings: BindingRow[];
} = { prompts: [], versions: [], bindings: [] };

const { promptFindUnique, promptFindMany, bindingFindMany } = vi.hoisted(
	() => ({
		promptFindUnique: vi.fn(),
		promptFindMany: vi.fn(),
		bindingFindMany: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		prompt: { findUnique: promptFindUnique, findMany: promptFindMany },
		promptBinding: { findMany: bindingFindMany },
	},
	Prisma: {},
}));

import { getPlatformWidePromptDeletionImpact } from "../prisma/queries/prompts";

/** The WHERE the binding traversal actually sent. */
const bindingWhere = () => bindingFindMany.mock.calls[0][0].where;

beforeEach(() => {
	fixture.prompts = [];
	fixture.versions = [];
	fixture.bindings = [];

	promptFindUnique.mockReset();
	promptFindUnique.mockImplementation(
		async ({ where }: any) =>
			fixture.prompts.find((p) => p.id === where.id) ?? null,
	);

	promptFindMany.mockReset();
	promptFindMany.mockImplementation(async ({ where }: any) =>
		fixture.prompts
			.filter((p) => p.key === where.key && p.scope === where.scope)
			.map((p) => ({ id: p.id })),
	);

	bindingFindMany.mockReset();
	// Resolves each binding through its VERSION to a prompt id, the way the
	// relation filter does, so a query that narrowed to one version would drop
	// rows here instead of silently passing.
	bindingFindMany.mockImplementation(async ({ where }: any) => {
		const wanted: string[] = where.promptVersion.promptId.in;
		return fixture.bindings
			.filter((b) => {
				const version = fixture.versions.find(
					(v) => v.id === b.promptVersionId,
				);
				return !!version && wanted.includes(version.promptId);
			})
			.filter(
				(b) =>
					where.targetType === undefined ||
					b.targetType === where.targetType,
			)
			.map((b) => ({
				documentType: b.documentType,
				organizationId: b.organizationId,
				userId: b.userId,
			}));
	});
});

/** A SYSTEM prompt with two versions; bindings are added per test. */
function seedSystemPrompt(id: string, key: string) {
	fixture.prompts.push({ id, key, scope: "SYSTEM" });
	fixture.versions.push(
		{ id: `${id}-v1`, promptId: id },
		{ id: `${id}-v2`, promptId: id },
	);
}

function binding(over: Partial<BindingRow> & { promptVersionId: string }) {
	fixture.bindings.push({
		targetType: "AGENT",
		documentType: "PRD",
		organizationId: null,
		userId: null,
		...over,
	});
}

describe("getPlatformWidePromptDeletionImpact", () => {
	it("reports zero and an empty label list for a prompt nothing is bound to", async () => {
		seedSystemPrompt("p-1", "prd_writer");

		expect(
			await getPlatformWidePromptDeletionImpact({ promptId: "p-1" }),
		).toEqual({
			promptRowCount: 1,
			bindingCount: 0,
			organizationCount: 0,
			personalOverrideUserCount: 0,
			documentTypeLabels: [],
		});
	});

	// AE6. Bindings advance to the newest version, but nothing removes the old
	// ones — and the cascade takes them all. Counting only the latest version
	// would understate every prompt that has ever been re-authored.
	it("counts a binding attached to a version that is not the latest", async () => {
		seedSystemPrompt("p-1", "prd_writer");
		binding({ promptVersionId: "p-1-v1", organizationId: "org-1" });

		const impact = await getPlatformWidePromptDeletionImpact({
			promptId: "p-1",
		});

		expect(impact?.bindingCount).toBe(1);
		// Asked of the PROMPT, never of one version.
		expect(bindingWhere().promptVersion).toEqual({
			promptId: { in: ["p-1"] },
		});
	});

	// The one filter `listActionsForPrompt` carries that this query must not.
	// PromptTargetType has AGENT, FEATURE, WORKFLOW and DOCUMENT, and the
	// cascade does not care which.
	it("counts a binding whose target type is not AGENT", async () => {
		seedSystemPrompt("p-1", "prd_writer");
		binding({
			promptVersionId: "p-1-v2",
			targetType: "WORKFLOW",
			organizationId: "org-1",
		});

		const impact = await getPlatformWidePromptDeletionImpact({
			promptId: "p-1",
		});

		expect(impact?.bindingCount).toBe(1);
		expect(bindingWhere().targetType).toBeUndefined();
	});

	// AE4. The figure an operator acts on, and the one thing it must not leak.
	it("separates affected organizations from personal overrides, and names neither", async () => {
		seedSystemPrompt("p-1", "prd_writer");
		binding({ promptVersionId: "p-1-v2", organizationId: "org-1" });
		binding({ promptVersionId: "p-1-v2", organizationId: "org-2" });
		binding({ promptVersionId: "p-1-v1", userId: "user-1" });

		const impact = await getPlatformWidePromptDeletionImpact({
			promptId: "p-1",
		});

		expect(impact).toEqual({
			promptRowCount: 1,
			bindingCount: 3,
			organizationCount: 2,
			// A personal override is counted in the total AND on its own,
			// never folded into the organization figure.
			personalOverrideUserCount: 1,
			documentTypeLabels: ["PRD"],
		});

		// No tenant predicate: this read is cross-tenant on purpose.
		expect(bindingWhere().organizationId).toBeUndefined();
		expect(bindingWhere().userId).toBeUndefined();
		expect(bindingWhere().scope).toBeUndefined();
		expect(bindingWhere().OR).toBeUndefined();

		// And nothing in the result can name who was affected.
		const serialized = JSON.stringify(impact);
		expect(serialized).not.toContain("org-1");
		expect(serialized).not.toContain("org-2");
		expect(serialized).not.toContain("user-1");
	});

	// A platform-tier binding (both seeds create one per seeded prompt) has no
	// organization and no user. Calling it a personal override would tell the
	// operator that people hold preferences they never set.
	it("does not count a SYSTEM-tier binding as somebody's personal override", async () => {
		seedSystemPrompt("p-1", "prd_writer");
		binding({ promptVersionId: "p-1-v2" });

		const impact = await getPlatformWidePromptDeletionImpact({
			promptId: "p-1",
		});

		expect(impact?.bindingCount).toBe(1);
		expect(impact?.personalOverrideUserCount).toBe(0);
		expect(impact?.organizationCount).toBe(0);
	});

	it("collapses two bindings of the same document type to one label", async () => {
		seedSystemPrompt("p-1", "prd_writer");
		binding({
			promptVersionId: "p-1-v2",
			documentType: "PRD",
			organizationId: "org-1",
		});
		binding({
			promptVersionId: "p-1-v1",
			documentType: "PRD",
			organizationId: "org-2",
		});
		binding({
			promptVersionId: "p-1-v2",
			documentType: "ADR",
			organizationId: "org-1",
		});

		const impact = await getPlatformWidePromptDeletionImpact({
			promptId: "p-1",
		});

		expect(impact?.bindingCount).toBe(3);
		expect(impact?.documentTypeLabels).toEqual([
			"Architecture Decision Record",
			"PRD",
		]);
	});

	it("ignores a binding belonging to a prompt with a different key", async () => {
		seedSystemPrompt("p-1", "prd_writer");
		seedSystemPrompt("p-other", "architecture_writer");
		binding({ promptVersionId: "p-1-v2", organizationId: "org-1" });
		binding({ promptVersionId: "p-other-v1", organizationId: "org-2" });

		const impact = await getPlatformWidePromptDeletionImpact({
			promptId: "p-1",
		});

		expect(impact?.bindingCount).toBe(1);
		expect(impact?.organizationCount).toBe(1);
	});

	// AE15. Duplicate SYSTEM keys are legal — the unique index spans two
	// nullable owner columns — and resolution takes the first match, so the
	// deletion has to take both rows. An impact computed from the selected row
	// alone would report zero here while the cascade removed a live binding.
	it("covers every SYSTEM row carrying the key, including one the operator did not select", async () => {
		seedSystemPrompt("p-selected", "prd_writer");
		seedSystemPrompt("p-duplicate", "prd_writer");
		binding({ promptVersionId: "p-duplicate-v1", organizationId: "org-1" });
		binding({ promptVersionId: "p-duplicate-v2", userId: "user-1" });

		const impact = await getPlatformWidePromptDeletionImpact({
			promptId: "p-selected",
		});

		expect(impact?.promptRowCount).toBe(2);
		expect(impact?.bindingCount).toBe(2);
		expect(impact?.organizationCount).toBe(1);
		expect(impact?.personalOverrideUserCount).toBe(1);
		expect(bindingWhere().promptVersion.promptId.in).toEqual(
			expect.arrayContaining(["p-selected", "p-duplicate"]),
		);
	});

	// A prompt someone else deleted a moment ago is not an impact of zero; the
	// caller has to be able to tell the two apart (R11).
	it("returns null for a prompt id that no longer exists", async () => {
		expect(
			await getPlatformWidePromptDeletionImpact({ promptId: "p-gone" }),
		).toBeNull();
		expect(bindingFindMany).not.toHaveBeenCalled();
	});
});

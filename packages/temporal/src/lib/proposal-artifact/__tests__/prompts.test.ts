/**
 * The coordinated Proposal job's prompt resolver (Fizzy #2801).
 *
 * The resolver runs against the REAL `getBoundPromptForAgent`; only the
 * database client underneath it is replaced, by an in-memory binding table that
 * evaluates the `where` and `orderBy` the query actually issues. Mocking the
 * query wholesale would only prove the resolver called it. This proves which
 * binding wins: the new action's own, at the version it points at, with
 * precedence untouched.
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Scope = "SYSTEM" | "ORG" | "USER";

type BindingRow = {
	id: string;
	targetType: "AGENT";
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
	scope: Scope;
	userId: string | null;
	organizationId: string | null;
	projectId: string | null;
	isDefault: boolean;
	promptVersionId: string;
};

type VersionRow = {
	id: string;
	promptId: string;
	version: number;
	content: string;
	variables: Record<string, unknown>;
};

type PromptRow = { id: string; key: string; name: string; scope: Scope };

const { table, findFirst, promptFindUnique } = vi.hoisted(() => {
	const table = {
		bindings: [] as BindingRow[],
		versions: [] as VersionRow[],
		prompts: [] as PromptRow[],
	};
	return {
		table,
		findFirst: vi.fn(),
		promptFindUnique: vi.fn(),
	};
});

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		promptBinding: { findFirst },
		prompt: { findUnique: promptFindUnique },
	},
	Prisma: {},
}));

vi.mock("@repo/database", async () => {
	const prompts = await vi.importActual<
		typeof import("@repo/database/prisma/queries/prompts")
	>("@repo/database/prisma/queries/prompts");
	return { getBoundPromptForAgent: prompts.getBoundPromptForAgent };
});

import {
	findBoundProposalPrompt,
	proposalPromptNotBoundMessage,
	resolveBoundProposalPrompt,
} from "../prompts";
import { PROPOSAL_PROMPT_NOT_BOUND } from "../types";

// PostgreSQL orders an enum by declaration: SYSTEM, ORG, USER.
const SCOPE_ORDER: Record<Scope, number> = { SYSTEM: 0, ORG: 1, USER: 2 };

type Where = Record<string, unknown>;

/** Equality per field, `OR` as any-of — the subset of Prisma the query uses. */
function matches(row: Record<string, unknown>, where: Where): boolean {
	return Object.entries(where).every(([field, condition]) => {
		if (field === "OR") {
			return (condition as Where[]).some((arm) => matches(row, arm));
		}
		return (row[field] ?? null) === (condition ?? null);
	});
}

type OrderBy = Record<
	string,
	"asc" | "desc" | { sort: "asc" | "desc"; nulls: "first" | "last" }
>;

function compareBy(orderBy: OrderBy[]) {
	return (a: BindingRow, b: BindingRow): number => {
		for (const clause of orderBy) {
			const [field, spec] = Object.entries(clause)[0];
			const sort = typeof spec === "string" ? spec : spec.sort;
			const nulls = typeof spec === "string" ? "last" : spec.nulls;
			const av = (a as Record<string, unknown>)[field] ?? null;
			const bv = (b as Record<string, unknown>)[field] ?? null;
			if (av === bv) {
				continue;
			}
			if (av === null) {
				return nulls === "first" ? -1 : 1;
			}
			if (bv === null) {
				return nulls === "first" ? 1 : -1;
			}
			const rank = (v: unknown) =>
				field === "scope" ? SCOPE_ORDER[v as Scope] : String(v);
			const diff = rank(av) < rank(bv) ? -1 : 1;
			return sort === "desc" ? -diff : diff;
		}
		return 0;
	};
}

function seedPrompt(
	prompt: PromptRow,
	versions: Array<{ id: string; version: number }>,
) {
	table.prompts.push(prompt);
	for (const v of versions) {
		table.versions.push({
			id: v.id,
			promptId: prompt.id,
			version: v.version,
			content: `${prompt.name} v${v.version}`,
			variables: {},
		});
	}
}

let bindingSeq = 0;
function bind(
	row: Partial<BindingRow> &
		Pick<BindingRow, "targetKey" | "scope" | "promptVersionId">,
) {
	bindingSeq += 1;
	table.bindings.push({
		id: `binding-${bindingSeq}`,
		targetType: "AGENT",
		documentType: "PROPOSAL",
		storyKind: null,
		userId: null,
		organizationId: null,
		projectId: null,
		isDefault: true,
		...row,
	});
}

const lookup = (
	overrides: Partial<Parameters<typeof resolveBoundProposalPrompt>[0]> = {},
) => ({
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
	action: "proposal_client_main" as const,
	...overrides,
});

/** The `where` of every binding lookup the resolver issued. */
const issuedWheres = () => findFirst.mock.calls.map((c) => c[0].where);

beforeEach(() => {
	table.bindings.length = 0;
	table.versions.length = 0;
	table.prompts.length = 0;
	bindingSeq = 0;

	findFirst.mockReset();
	findFirst.mockImplementation(
		async (args: { where: Where; orderBy: OrderBy[] }) => {
			const [winner] = table.bindings
				.filter((row) => matches(row, args.where))
				.sort(compareBy(args.orderBy));
			if (!winner) {
				return null;
			}
			const promptVersion = table.versions.find(
				(v) => v.id === winner.promptVersionId,
			);
			return { ...winner, promptVersion };
		},
	);
	promptFindUnique.mockReset();
	promptFindUnique.mockImplementation(
		async (args: { where: { id: string } }) => {
			const prompt = table.prompts.find((p) => p.id === args.where.id);
			return prompt
				? {
						...prompt,
						description: null,
						format: "MARKDOWN",
						category: null,
						tags: [],
					}
				: null;
		},
	);

	// The seeded client-only Main prompt and analysis prompt.
	seedPrompt(
		{
			id: "prompt-sys-main",
			key: "proposal_client_main",
			name: "Client Proposal (Main)",
			scope: "SYSTEM",
		},
		[{ id: "pv-sys-main-1", version: 1 }],
	);
	seedPrompt(
		{
			id: "prompt-sys-analysis",
			key: "proposal_internal_analysis",
			name: "Proposal Internal Analysis",
			scope: "SYSTEM",
		},
		[{ id: "pv-sys-analysis-1", version: 1 }],
	);
});

describe("findBoundProposalPrompt / resolveBoundProposalPrompt", () => {
	it("asks for the Main action's own default binding at PROPOSAL, with the system and organization tiers and the project narrowing, never the personal tier", async () => {
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});

		await resolveBoundProposalPrompt(lookup());

		expect(findFirst).toHaveBeenCalledTimes(1);
		const where = issuedWheres()[0];
		expect(where).toMatchObject({
			targetType: "AGENT",
			targetKey: "proposal_client_main",
			documentType: "PROPOSAL",
			storyKind: null,
			isDefault: true,
		});
		expect(where.OR).toEqual([
			{ scope: "SYSTEM" },
			{
				scope: "ORG",
				organizationId: "org-1",
				OR: [{ projectId: "project-1" }, { projectId: null }],
			},
		]);
	});

	it("asks for the analysis action with every tier, the personal one included", async () => {
		bind({
			targetKey: "proposal_internal_analysis",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-analysis-1",
		});

		await resolveBoundProposalPrompt(
			lookup({ action: "proposal_internal_analysis" }),
		);

		expect(issuedWheres()[0].OR).toEqual(
			expect.arrayContaining([
				{ scope: "SYSTEM" },
				{
					scope: "ORG",
					organizationId: "org-1",
					OR: [{ projectId: "project-1" }, { projectId: null }],
				},
				{ scope: "USER", userId: "user-1" },
			]),
		);
	});

	it("ignores a personal binding on the client-only Main action itself, even one written straight to the table", async () => {
		// The bind procedure refuses this row; one that got in another way
		// must still never steer the client document.
		seedPrompt(
			{
				id: "prompt-personal-main",
				key: "my_client_proposal",
				name: "My client proposal",
				scope: "USER",
			},
			[{ id: "pv-personal-main-1", version: 1 }],
		);
		bind({
			targetKey: "proposal_client_main",
			scope: "USER",
			userId: "user-1",
			promptVersionId: "pv-personal-main-1",
		});
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});

		await expect(resolveBoundProposalPrompt(lookup())).resolves.toEqual({
			promptId: "prompt-sys-main",
			versionNumber: 1,
			promptVersionId: "pv-sys-main-1",
		});
	});

	it("fails closed when the only binding on the Main action is a personal one", async () => {
		seedPrompt(
			{
				id: "prompt-personal-main",
				key: "my_client_proposal",
				name: "My client proposal",
				scope: "USER",
			},
			[{ id: "pv-personal-main-1", version: 1 }],
		);
		bind({
			targetKey: "proposal_client_main",
			scope: "USER",
			userId: "user-1",
			promptVersionId: "pv-personal-main-1",
		});

		const error = await resolveBoundProposalPrompt(lookup()).catch(
			(caught: unknown) => caught,
		);

		expect((error as ApplicationFailure).type).toBe(
			PROPOSAL_PROMPT_NOT_BOUND,
		);
	});

	it("keeps a member's personal binding on the analysis action ahead of the system seed", async () => {
		seedPrompt(
			{
				id: "prompt-personal-analysis",
				key: "my_analysis",
				name: "My analysis",
				scope: "USER",
			},
			[{ id: "pv-personal-analysis-1", version: 1 }],
		);
		bind({
			targetKey: "proposal_internal_analysis",
			scope: "USER",
			userId: "user-1",
			promptVersionId: "pv-personal-analysis-1",
		});
		bind({
			targetKey: "proposal_internal_analysis",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-analysis-1",
		});

		await expect(
			resolveBoundProposalPrompt(
				lookup({ action: "proposal_internal_analysis" }),
			),
		).resolves.toEqual({
			promptId: "prompt-personal-analysis",
			versionNumber: 1,
			promptVersionId: "pv-personal-analysis-1",
		});
	});

	it("ignores a personal binding of an older prompt to the Draft flow's PROPOSAL action", async () => {
		// The combined Draft prompt a member pinned for themselves. It outranks
		// everything at `project_document_generator:PROPOSAL`, and must reach
		// nothing at the client-only Main action.
		seedPrompt(
			{
				id: "prompt-personal-draft",
				key: "my_proposal",
				name: "My combined proposal",
				scope: "USER",
			},
			[{ id: "pv-personal-draft-1", version: 1 }],
		);
		bind({
			targetKey: "project_document_generator",
			scope: "USER",
			userId: "user-1",
			promptVersionId: "pv-personal-draft-1",
		});
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});

		await expect(resolveBoundProposalPrompt(lookup())).resolves.toEqual({
			promptId: "prompt-sys-main",
			versionNumber: 1,
			promptVersionId: "pv-sys-main-1",
		});
	});

	it("lets an organization binding outrank the system seed, at the version it points at rather than the newest", async () => {
		seedPrompt(
			{
				id: "prompt-org-main",
				key: "org_client_proposal",
				name: "Org client proposal",
				scope: "ORG",
			},
			[
				{ id: "pv-org-main-2", version: 2 },
				// Newer, and bound nowhere: an edit nobody pointed a binding at.
				{ id: "pv-org-main-3", version: 3 },
			],
		);
		// A newer SYSTEM version in another scope, bound at the SYSTEM tier.
		seedPrompt(
			{
				id: "prompt-sys-main-v5",
				key: "proposal_client_main_next",
				name: "Client Proposal (Main) next",
				scope: "SYSTEM",
			},
			[{ id: "pv-sys-main-5", version: 5 }],
		);
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-5",
		});
		bind({
			targetKey: "proposal_client_main",
			scope: "ORG",
			organizationId: "org-1",
			promptVersionId: "pv-org-main-2",
		});

		await expect(resolveBoundProposalPrompt(lookup())).resolves.toEqual({
			promptId: "prompt-org-main",
			versionNumber: 2,
			promptVersionId: "pv-org-main-2",
		});
	});

	it("lets a project-narrowed organization binding outrank the org-wide one", async () => {
		seedPrompt(
			{
				id: "prompt-org-wide",
				key: "org_wide",
				name: "Org-wide",
				scope: "ORG",
			},
			[{ id: "pv-org-wide-1", version: 1 }],
		);
		seedPrompt(
			{
				id: "prompt-project",
				key: "project_specific",
				name: "Project-specific",
				scope: "ORG",
			},
			[{ id: "pv-project-4", version: 4 }],
		);
		bind({
			targetKey: "proposal_client_main",
			scope: "ORG",
			organizationId: "org-1",
			promptVersionId: "pv-org-wide-1",
		});
		bind({
			targetKey: "proposal_client_main",
			scope: "ORG",
			organizationId: "org-1",
			projectId: "project-1",
			promptVersionId: "pv-project-4",
		});

		await expect(resolveBoundProposalPrompt(lookup())).resolves.toEqual({
			promptId: "prompt-project",
			versionNumber: 4,
			promptVersionId: "pv-project-4",
		});
	});

	it("never reads another organization's binding", async () => {
		seedPrompt(
			{
				id: "prompt-other-org",
				key: "other_org",
				name: "Other org",
				scope: "ORG",
			},
			[{ id: "pv-other-org-1", version: 1 }],
		);
		bind({
			targetKey: "proposal_client_main",
			scope: "ORG",
			organizationId: "org-2",
			promptVersionId: "pv-other-org-1",
		});
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});

		const resolved = await resolveBoundProposalPrompt(lookup());
		expect(resolved.promptId).toBe("prompt-sys-main");
	});

	it("does not run a binding saved without Set as default", async () => {
		seedPrompt(
			{
				id: "prompt-org-offer",
				key: "org_offer",
				name: "Org offer",
				scope: "ORG",
			},
			[{ id: "pv-org-offer-1", version: 1 }],
		);
		bind({
			targetKey: "proposal_client_main",
			scope: "ORG",
			organizationId: "org-1",
			isDefault: false,
			promptVersionId: "pv-org-offer-1",
		});
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});

		const resolved = await resolveBoundProposalPrompt(lookup());
		expect(resolved.promptId).toBe("prompt-sys-main");
	});

	it("resolves the analysis action from its own binding, never the Main one", async () => {
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});
		bind({
			targetKey: "proposal_internal_analysis",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-analysis-1",
		});

		await expect(
			resolveBoundProposalPrompt(
				lookup({ action: "proposal_internal_analysis" }),
			),
		).resolves.toEqual({
			promptId: "prompt-sys-analysis",
			versionNumber: 1,
			promptVersionId: "pv-sys-analysis-1",
		});
		expect(issuedWheres()[0].targetKey).toBe("proposal_internal_analysis");
	});

	it("fails closed and non-retryably when nothing is bound to the Main action", async () => {
		// The Draft flow's prompt is bound, and must not be borrowed.
		bind({
			targetKey: "project_document_generator",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});

		await expect(findBoundProposalPrompt(lookup())).resolves.toBeNull();

		const failure = await resolveBoundProposalPrompt(lookup()).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).type).toBe(
			PROPOSAL_PROMPT_NOT_BOUND,
		);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect((failure as ApplicationFailure).message).toContain(
			'"Client proposal (Main)"',
		);
		expect((failure as ApplicationFailure).message).toMatch(
			/cannot be generated/,
		);
	});

	it("names the analysis action when that one is unbound", async () => {
		const failure = await resolveBoundProposalPrompt(
			lookup({ action: "proposal_internal_analysis" }),
		).catch((error: unknown) => error);

		expect((failure as ApplicationFailure).type).toBe(
			PROPOSAL_PROMPT_NOT_BOUND,
		);
		expect((failure as ApplicationFailure).message).toContain(
			'"Proposal internal analysis"',
		);
	});

	it("treats a prompt deleted between the two reads as unbound", async () => {
		bind({
			targetKey: "proposal_client_main",
			scope: "SYSTEM",
			promptVersionId: "pv-sys-main-1",
		});
		promptFindUnique.mockResolvedValueOnce(null);

		const failure = await resolveBoundProposalPrompt(lookup()).catch(
			(error: unknown) => error,
		);
		expect((failure as ApplicationFailure).type).toBe(
			PROPOSAL_PROMPT_NOT_BOUND,
		);
	});

	it("lets a database error through untouched, so the activity retries it", async () => {
		const outage = new Error("connection terminated");
		findFirst.mockRejectedValueOnce(outage);

		await expect(resolveBoundProposalPrompt(lookup())).rejects.toBe(outage);
	});
});

describe("proposalPromptNotBoundMessage", () => {
	it("tells an administrator where to bind, and names no record or tenant", () => {
		const message = proposalPromptNotBoundMessage("proposal_client_main");

		expect(message).toContain("Client proposal (Main)");
		expect(message).toMatch(/organization admin/i);
		expect(message).toContain("Prompt Library");
		expect(message).not.toMatch(/org-1|user-1|project-1|prompt-/);
	});
});

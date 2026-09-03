/**
 * Every reader must back the org-wide tier with the SAME rows.
 *
 * CLAUDE.md names four queries that have to move together or "the UI starts
 * contradicting the runtime": getBoundPromptVersion (what runs),
 * getBindingStatusForPrompts (the badge), listPromptCatalog (the catalog's
 * in-force marker) and listPromptsForStages (the stage panel).
 *
 * Two of them drifted. getBoundPromptVersion excludes project-narrowed rows
 * from the org-wide tier with an explicit `projectId: null` — "project-narrowed
 * rows were consulted above and must not double-count here" — and
 * getBindingStatusForPrompts matches it. listPromptCatalog and
 * listPromptsForStages did not, so a PROJECT-tier row joined the org-wide
 * ranking and could be badged in force on the organization's Prompt Library,
 * which calls the catalog with no project at all. The agent would never resolve
 * that row there.
 *
 * The rule this file pins: when no project is in scope, the ORG condition
 * carries `projectId: null`; when one is, it carries both arms explicitly
 * (`in: [id, null]` is not valid Prisma for a nullable column).
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-reader-project-parity.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: {
		promptBinding: {
			findMany: (args: unknown) => findMany(args),
		},
	},
	Prisma: {},
}));

import {
	getBindingStatusForPrompts,
	listPromptCatalog,
	listPromptsForStages,
} from "../prisma/queries/prompts";

const ORG = "org-1";
const PROJECT = "proj-1";
const USER = "user-1";

/** The ORG arm of the where-clause the reader actually sent. */
const orgCondition = () => {
	const where = findMany.mock.calls[0][0].where as {
		OR: Array<Record<string, unknown>>;
	};
	return where.OR.find((c) => c.scope === "ORG");
};

beforeEach(() => {
	findMany.mockReset();
	findMany.mockResolvedValue([]);
});

/** Each reader, driven with and without a project in scope. */
const readers = [
	{
		name: "listPromptCatalog",
		run: (projectId?: string) =>
			listPromptCatalog({ userId: USER, organizationId: ORG, projectId }),
	},
	{
		name: "listPromptsForStages",
		run: (projectId?: string) =>
			listPromptsForStages({
				agentName: "project_document_generator",
				documentTypes: ["DRAFT"],
				userId: USER,
				organizationId: ORG,
				projectId,
			}),
	},
	{
		name: "getBindingStatusForPrompts",
		run: (projectId?: string) =>
			getBindingStatusForPrompts({
				promptIds: ["p1"],
				userId: USER,
				organizationId: ORG,
				projectId,
			}),
	},
] as const;

describe("org-wide tier excludes project-narrowed rows", () => {
	for (const reader of readers) {
		it(`${reader.name} pins projectId: null when no project is in scope`, async () => {
			await reader.run(undefined);

			expect(orgCondition()).toEqual({
				scope: "ORG",
				organizationId: ORG,
				projectId: null,
			});
		});
	}
});

describe("a project in scope admits its own rows beside the org-wide ones", () => {
	for (const reader of readers) {
		it(`${reader.name} asks for both arms`, async () => {
			await reader.run(PROJECT);

			expect(orgCondition()).toEqual({
				scope: "ORG",
				organizationId: ORG,
				OR: [{ projectId: PROJECT }, { projectId: null }],
			});
		});
	}
});

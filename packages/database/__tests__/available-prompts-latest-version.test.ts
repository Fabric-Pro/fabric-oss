/**
 * `listAvailablePromptsForAgent` lists a prompt once per binding, and its
 * `latestVersion` must be the prompt's newest version on every row (Fizzy
 * #2807) — the version document generation renders, and the one the prompt
 * picker carries into generation and into "Bind as Default".
 *
 * It used to be the version each row's binding pins. Saving a new version
 * re-points only the bindings at the prompt's own scope, so a prompt also bound
 * at another tier arrives with two different "latest" versions, and whichever
 * row the picker kept decided whether it bound a months-old version. Both
 * orders are pinned below: an old pin on the non-default row, and an old pin on
 * the default row.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/available-prompts-latest-version.test.ts
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

import { listAvailablePromptsForAgent } from "../prisma/queries/prompts";

const PROMPT = {
	id: "prompt_proposal",
	key: "proposal_template",
	name: "Project Proposal Document",
	description: null,
	scope: "SYSTEM",
	category: null,
	tags: [],
	forkedFrom: null,
	// What the query asks for: the newest version only.
	versions: [{ id: "pv_9", version: 9, content: "Proposal instructions v9" }],
};

function binding(opts: {
	scope: "SYSTEM" | "ORG";
	isDefault: boolean;
	pinned: { id: string; version: number };
}) {
	return {
		scope: opts.scope,
		projectId: null,
		isDefault: opts.isDefault,
		promptVersion: {
			...opts.pinned,
			content: `Proposal instructions v${opts.pinned.version}`,
			prompt: PROMPT,
		},
	};
}

function list() {
	return listAvailablePromptsForAgent({
		agentName: "project_document_generator",
		userId: "user-1",
		organizationId: "org-1",
		documentType: "PROPOSAL",
	});
}

beforeEach(() => {
	findMany.mockReset();
});

describe("listAvailablePromptsForAgent latestVersion", () => {
	it("asks for each bound prompt's newest version", async () => {
		findMany.mockResolvedValue([]);

		await list();

		const include = findMany.mock.calls[0][0].include;
		expect(include.promptVersion.include.prompt.include.versions).toEqual({
			orderBy: { version: "desc" },
			take: 1,
			select: { id: true, version: true, content: true },
		});
	});

	it.each([
		[
			"an old pin on the non-default row",
			{ id: "pv_3", version: 3 },
			{ id: "pv_9", version: 9 },
		],
		[
			"an old pin on the default row",
			{ id: "pv_9", version: 9 },
			{ id: "pv_3", version: 3 },
		],
	])(
		"reports the newest version on every row with %s",
		async (_label, orgPin, systemPin) => {
			findMany.mockResolvedValue([
				binding({ scope: "ORG", isDefault: false, pinned: orgPin }),
				binding({
					scope: "SYSTEM",
					isDefault: true,
					pinned: systemPin,
				}),
			]);

			const prompts = await list();

			expect(prompts).toHaveLength(2);
			for (const prompt of prompts) {
				expect(prompt.latestVersion).toEqual({
					id: "pv_9",
					version: 9,
				});
				// The preview is of the same version the row selects and
				// binds, never of an older pin.
				expect(prompt.contentSnippet).toBe("Proposal instructions v9");
			}
		},
	);

	it("falls back to the pinned version when the prompt reports none", async () => {
		findMany.mockResolvedValue([
			{
				...binding({
					scope: "SYSTEM",
					isDefault: true,
					pinned: { id: "pv_4", version: 4 },
				}),
				promptVersion: {
					id: "pv_4",
					version: 4,
					content: "Proposal instructions v4",
					prompt: { ...PROMPT, versions: [] },
				},
			},
		]);

		const [prompt] = await list();

		expect(prompt.latestVersion).toEqual({ id: "pv_4", version: 4 });
		expect(prompt.contentSnippet).toBe("Proposal instructions v4");
	});
});

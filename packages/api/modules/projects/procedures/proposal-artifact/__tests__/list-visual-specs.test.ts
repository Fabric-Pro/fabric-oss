/**
 * `projects.proposalArtifact.listVisualSpecs` (Fizzy #2946): the stored
 * visuals of a Proposal in artifact mode as a client may know them, for
 * members and project guests alike: ids, hashes, kind and origin, never the
 * spec, its hash or its author.
 *
 * The gate middleware, the permission decision and the loader are the real
 * ones over the world in `proposal-artifact-harness.ts`; the spec read is a
 * mock that answers rows carrying every stored column, so the test shows the
 * procedure passes on only the four it names.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const specs = vi.hoisted(() => ({
	listProposalVisualSpecSummaries: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await (await import("./proposal-artifact-harness")).databaseModule()),
	listProposalVisualSpecSummaries: specs.listProposalVisualSpecSummaries,
}));
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { listProposalVisualSpecsProcedure } from "../list-visual-specs";
import {
	call,
	DOC_A,
	DOC_A2,
	DOC_PRD,
	declaredPermission,
	ORG_A,
	PROJECT_A,
	PROJECT_B,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const STORED_ROW = {
	visualId: "k3v9q2m7x1a8c4d6",
	sourceHash: "v1:0123456789abcdef",
	kind: "flow",
	origin: "STEP",
	// Columns the read must never pass on, were they ever selected.
	spec: { kind: "flow", steps: [{ label: "Discovery" }] },
	specHash: "v1:fedcba9876543210",
	createdById: USERS.owner,
	organizationId: ORG_A,
};

function listVisualSpecs(
	userId: string,
	ids: { projectId: string; documentId: string } = {
		projectId: PROJECT_A,
		documentId: DOC_A,
	},
) {
	return call(listProposalVisualSpecsProcedure, ids, userId) as Promise<{
		specs: Array<Record<string, unknown>>;
	}>;
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	specs.listProposalVisualSpecSummaries.mockReset();
	specs.listProposalVisualSpecSummaries.mockResolvedValue([
		STORED_ROW,
		{
			...STORED_ROW,
			visualId: "m2p8r4t6v1x3z5b7",
			origin: "INSTRUCTION",
		},
	]);
});

describe("declared chain", () => {
	it("runs the rollout gate, then DOCUMENT_READ", () => {
		const chain = (
			listProposalVisualSpecsProcedure as { __chain: unknown[] }
		).__chain;
		expect(chain).toHaveLength(2);
		expect(typeof chain[0]).toBe("function");
		expect(declaredPermission(listProposalVisualSpecsProcedure)).toBe(
			"document:read",
		);
	});
});

describe("listVisualSpecs", () => {
	it.each([
		["a project guest with a VIEWER role", USERS.guestViewer],
		["a project guest with an EDITOR role", USERS.guestEditor],
		["an organization member", USERS.memberViewer],
	])("gives %s exactly the four summary keys", async (_label, userId) => {
		const { specs: rows } = await listVisualSpecs(userId);

		expect(rows).toEqual([
			{
				visualId: "k3v9q2m7x1a8c4d6",
				sourceHash: "v1:0123456789abcdef",
				kind: "flow",
				origin: "STEP",
			},
			{
				visualId: "m2p8r4t6v1x3z5b7",
				sourceHash: "v1:0123456789abcdef",
				kind: "flow",
				origin: "INSTRUCTION",
			},
		]);
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual([
				"kind",
				"origin",
				"sourceHash",
				"visualId",
			]);
		}
		expect(specs.listProposalVisualSpecSummaries).toHaveBeenCalledWith({
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentId: DOC_A,
		});
	});

	it("refuses a user outside the project as NOT_FOUND", async () => {
		const result = await refusal(listVisualSpecs(USERS.outsider));
		expect(result.code).toBe("NOT_FOUND");
		expect(specs.listProposalVisualSpecSummaries).not.toHaveBeenCalled();
	});

	it("refuses an outsider pairing their own project with this document as NOT_FOUND", async () => {
		const result = await refusal(
			listVisualSpecs(USERS.outsider, {
				projectId: PROJECT_B,
				documentId: DOC_A,
			}),
		);
		expect(result.code).toBe("NOT_FOUND");
		expect(specs.listProposalVisualSpecSummaries).not.toHaveBeenCalled();
	});

	it.each([
		["a document of another project", DOC_A2],
		["a document that is not a Proposal", DOC_PRD],
	])("refuses %s as NOT_FOUND", async (_label, documentId) => {
		const result = await refusal(
			listVisualSpecs(USERS.guestEditor, {
				projectId: PROJECT_A,
				documentId,
			}),
		);
		expect(result.code).toBe("NOT_FOUND");
		expect(specs.listProposalVisualSpecSummaries).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND with the gate off", async () => {
		world.flags.set(ORG_A, false);
		for (const userId of [USERS.owner, USERS.guestViewer]) {
			const result = await refusal(listVisualSpecs(userId));
			expect(result.code).toBe("NOT_FOUND");
		}
		expect(specs.listProposalVisualSpecSummaries).not.toHaveBeenCalled();
	});
});

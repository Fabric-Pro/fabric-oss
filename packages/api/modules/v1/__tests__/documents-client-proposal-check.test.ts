/**
 * v1 documents — an API-key content PATCH of a client-document Proposal is
 * checked like an AI chat accept, stricter on diagrams (Fizzy #2946).
 *
 *  - every existing diagram must survive unchanged, even when its section
 *    was removed or renamed (no person reviews this diff), though it may
 *    move: otherwise 422 `REVISION_CHANGED_DIAGRAM`, naming the diagram by
 *    section key and position, and nothing is written;
 *  - the body may not repeat 12+ consecutive words of an answer the key's
 *    creator was shown as settled: otherwise 422 `RESPONSE_ECHOED`, naming
 *    no text; a creator with no settled block (a project guest) gets the
 *    diagram check alone;
 *  - prose may change anywhere;
 *  - whether the check applies, and whose answers count, is judged by the
 *    project's owning organization, never the caller's;
 *  - other document types and Proposals with the gate off are unchanged.
 *
 * `checkPreservation` and `checkResponseEcho` run for real; storage, the
 * gate and the settled-decisions block are faked.
 */

import { contentIdentity } from "@repo/utils/content-identity";
import { SCOPED_REVISION_REFUSAL } from "@repo/utils/proposal-artifact/scoped-revision-codes";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class DocumentVersionConflictError extends Error {}
	return {
		getDocumentById: vi.fn(),
		updateDocument: vi.fn(),
		hasProjectAccess: vi.fn(),
		canEditProject: vi.fn(),
		isProposalClientDocument: vi.fn(),
		listVisualSpecs: vi.fn(),
		buildSettledDecisionsBlock: vi.fn(),
		emitDocumentChange: vi.fn(),
		DocumentVersionConflictError,
	};
});

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-caller",
	})),
	IntegrationContractStatusManagedError: class extends Error {},
	DocumentVersionConflictError: mocks.DocumentVersionConflictError,
	DocumentGenerationInProgressError: class extends Error {},
	isProposalClientDocument: (...args: unknown[]) =>
		mocks.isProposalClientDocument(...args),
	listProposalVisualSpecSummaries: (...args: unknown[]) =>
		mocks.listVisualSpecs(...args),
	sanitizeContent: (content: string) => content.split("\u0000").join(""),
	listDocuments: vi.fn(),
	getDocumentById: (...args: unknown[]) => mocks.getDocumentById(...args),
	createDocument: vi.fn(),
	updateDocument: (...args: unknown[]) => mocks.updateDocument(...args),
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	canEditProject: (...args: unknown[]) => mocks.canEditProject(...args),
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
}));

vi.mock(
	"@repo/temporal/proposal-artifact-settled-decisions",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@repo/temporal/proposal-artifact-settled-decisions")
		>()),
		buildSettledDecisionsBlock: (...args: unknown[]) =>
			mocks.buildSettledDecisionsBlock(...args),
	}),
);

vi.mock("../../../lib/realtime", () => ({
	emitDocumentChange: (...args: unknown[]) =>
		mocks.emitDocumentChange(...args),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerDocumentRoutes } from "../documents";

const MEMBER = "user-member";
const GUEST = "user-guest";
const OWNER_ORG = "org-owner";

function makeApp(userId: string) {
	const app = new Hono<{
		Variables: {
			externalApiContext: {
				keyType: "personal" | "organization";
				keyId: string;
				keyPrefix: string;
				userId: string;
				organizationId: string | undefined;
				scopes: string[];
			};
		};
	}>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId,
			organizationId: undefined,
			scopes: ["documents:read", "documents:write"],
		});
		await next();
	});
	registerDocumentRoutes(app as never);
	return app;
}

const STORED = [
	"# Example proposal",
	"",
	"Prepared for example-org.",
	"",
	"## Timeline",
	"",
	"```mermaid",
	"flowchart LR",
	"  Discovery --> Delivery",
	"```",
	"",
	"The plan runs in two phases.",
	"",
	"## Pricing",
	"",
	"The fee is agreed later.",
	"",
].join("\n");

/** `STORED` with one line replaced. */
function withLine(from: string, to: string, body = STORED): string {
	if (!body.includes(from)) {
		throw new Error(`fixture has no "${from}"`);
	}
	return body.replace(from, to);
}

const CHANGED_DIAGRAM = withLine(
	"  Discovery --> Delivery",
	"  Discovery --> Build --> Delivery",
);

/** The Timeline section under a new heading, its diagram changed. */
const RENAMED_CHANGED = withLine(
	"## Timeline",
	"## Delivery timeline",
	CHANGED_DIAGRAM,
);

/** The diagram moved under Pricing, the Timeline heading renamed. */
const MOVED_DIAGRAM = withLine(
	"The fee is agreed later.",
	"The fee is agreed later.\n\n```mermaid\nflowchart LR\n  Discovery --> Delivery\n```",
	withLine(
		"## Timeline\n\n```mermaid\nflowchart LR\n  Discovery --> Delivery\n```\n\n",
		"## Delivery timeline\n\n",
	),
);

const LONG_ANSWER =
	"the client asked us to keep the discovery workshop short and fully remote this quarter";

const ECHOING = withLine(
	"The fee is agreed later.",
	`The fee is agreed later, and ${LONG_ANSWER}.`,
);

const TIMELINE_KEY = buildSectionMap(STORED).sections.find(
	(section) => section.headingText === "Timeline",
)?.key;

function proposalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc-1",
		projectId: "proj-1",
		type: "PROPOSAL",
		title: "Example proposal",
		content: STORED,
		status: "COMPLETE",
		version: 3,
		wordCount: 30,
		createdAt: new Date("2026-10-01T00:00:00.000Z"),
		updatedAt: new Date("2026-10-01T00:00:00.000Z"),
		project: { organizationId: OWNER_ORG },
		...overrides,
	};
}

let written: string[];

function patch(body: Record<string, unknown>, userId = MEMBER) {
	return makeApp(userId).request("/documents/doc-1", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function errorOf(res: Response) {
	return (await res.json()) as {
		error: {
			message: string;
			code?: string;
			data?: { violations?: Array<Record<string, unknown>> };
		};
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	written = [];
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.canEditProject.mockResolvedValue(true);
	mocks.emitDocumentChange.mockResolvedValue(undefined);
	mocks.getDocumentById.mockResolvedValue(proposalRow());
	// The gate is on for the owning organization only.
	mocks.isProposalClientDocument.mockImplementation(
		async (args: { organizationId: string | null; documentType: string }) =>
			args.documentType === "PROPOSAL" &&
			args.organizationId === OWNER_ORG,
	);
	mocks.listVisualSpecs.mockResolvedValue([]);
	// Stands in for the builder: a block for a member of the owning
	// organization, none for anyone else (a project guest included).
	mocks.buildSettledDecisionsBlock.mockImplementation(
		async (args: { starterUserId: string; organizationId: string }) =>
			args.starterUserId === MEMBER && args.organizationId === OWNER_ORG
				? {
						block: "",
						analysisBlock: "",
						itemCount: 1,
						carried: {
							responseTexts: [LONG_ANSWER],
							findingTitles: ["Workshop format is unclear"],
							responseKeys: ["delivery|scope|workshop"],
							titleKeys: ["delivery|scope|workshop"],
						},
					}
				: null,
	);
	mocks.updateDocument.mockImplementation(
		async (_id: string, data: { content?: string }) => {
			if (data.content !== undefined) {
				written.push(data.content);
			}
			return proposalRow({ content: data.content ?? STORED, version: 4 });
		},
	);
});

describe("v1 PATCH of a client-document Proposal — diagrams", () => {
	it("refuses a changed diagram with 422 REVISION_CHANGED_DIAGRAM and writes nothing", async () => {
		const res = await patch({ content: CHANGED_DIAGRAM });

		expect(res.status).toBe(422);
		const body = await errorOf(res);
		expect(body.error.code).toBe(SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM);
		expect(body.error.data?.violations).toEqual([
			expect.objectContaining({
				code: SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
				sectionKey: TIMELINE_KEY,
				ordinal: 0,
			}),
		]);
		expect(body.error.message).toContain("diagram 1 (under “Timeline”)");
		expect(body.error.message).toContain("Edit with instructions");
		expect(mocks.listVisualSpecs).toHaveBeenCalledWith({
			organizationId: OWNER_ORG,
			projectId: "proj-1",
			documentId: "doc-1",
		});
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("refuses a removed diagram whose section stays", async () => {
		const removed = withLine(
			"```mermaid\nflowchart LR\n  Discovery --> Delivery\n```\n\n",
			"",
		);

		const res = await patch({ content: removed });

		expect(res.status).toBe(422);
		expect((await errorOf(res)).error.code).toBe(
			SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
		);
		expect(written).toEqual([]);
	});

	it("refuses a diagram removed with its whole section, since no person reviews the diff", async () => {
		const withoutTimeline = withLine(
			"## Timeline\n\n```mermaid\nflowchart LR\n  Discovery --> Delivery\n```\n\nThe plan runs in two phases.\n\n",
			"",
		);

		const res = await patch({ content: withoutTimeline });

		expect(res.status).toBe(422);
		expect((await errorOf(res)).error.code).toBe(
			SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
		);
		expect(written).toEqual([]);
	});

	it("refuses a changed diagram under a renamed heading", async () => {
		const res = await patch({ content: RENAMED_CHANGED });

		expect(res.status).toBe(422);
		const body = await errorOf(res);
		expect(body.error.code).toBe(SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM);
		expect(body.error.data?.violations).toEqual([
			expect.objectContaining({ sectionKey: TIMELINE_KEY, ordinal: 0 }),
		]);
		expect(written).toEqual([]);
	});

	it("saves a diagram moved to another section, and a renamed heading", async () => {
		const res = await patch({ content: MOVED_DIAGRAM });

		expect(res.status).toBe(200);
		expect(written).toEqual([MOVED_DIAGRAM]);
	});

	it("saves a prose change anywhere, the diagram kept", async () => {
		const next = withLine(
			"The plan runs in two phases.",
			"The plan runs in three phases.",
			withLine(
				"The fee is agreed later.",
				"The fee is fixed and monthly.",
			),
		);

		const res = await patch({
			content: next,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(STORED),
		});

		expect(res.status).toBe(200);
		expect(written).toEqual([next]);
		expect(mocks.listVisualSpecs).not.toHaveBeenCalled();
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
	});

	it("answers a refused change against a body the caller's base no longer names as a conflict", async () => {
		mocks.getDocumentById.mockResolvedValue(proposalRow({ version: 4 }));

		const res = await patch({
			content: CHANGED_DIAGRAM,
			expectedVersion: 3,
			expectedContentHash: contentIdentity("# an older body"),
		});

		expect(res.status).toBe(409);
		expect((await errorOf(res)).error.code).toBe(
			"DOCUMENT_VERSION_CONFLICT",
		);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("checks no title-only write", async () => {
		const res = await patch({ title: "Proposal for example-org" });

		expect(res.status).toBe(200);
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
	});
});

describe("v1 PATCH of a client-document Proposal — settled answers", () => {
	it("refuses a body that echoes a settled answer of the key's creator, naming no text", async () => {
		const res = await patch({ content: ECHOING });

		expect(res.status).toBe(422);
		const body = await errorOf(res);
		expect(body.error.code).toBe(SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED);
		expect(body.error).not.toHaveProperty("data");
		expect(JSON.stringify(body)).not.toContain("discovery workshop");
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith({
			projectId: "proj-1",
			documentId: "doc-1",
			starterUserId: MEMBER,
			organizationId: OWNER_ORG,
		});
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("lets an answer already in the stored Main stay", async () => {
		mocks.getDocumentById.mockResolvedValue(
			proposalRow({ content: ECHOING }),
		);
		const next = withLine(
			"The plan runs in two phases.",
			"The plan runs in three phases.",
			ECHOING,
		);

		const res = await patch({ content: next });

		expect(res.status).toBe(200);
		expect(written).toEqual([next]);
	});

	it("skips the echo for a project guest's key, which carried no answer", async () => {
		const res = await patch({ content: ECHOING }, GUEST);

		expect(res.status).toBe(200);
		expect(written).toEqual([ECHOING]);
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith(
			expect.objectContaining({ starterUserId: GUEST }),
		);
	});

	it("still refuses a project guest's key a changed diagram", async () => {
		const res = await patch({ content: CHANGED_DIAGRAM }, GUEST);

		expect(res.status).toBe(422);
		expect((await errorOf(res)).error.code).toBe(
			SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
		);
		expect(written).toEqual([]);
	});
});

describe("v1 PATCH — what the check applies to", () => {
	it("judges the gate and the answers by the owning organization, not the caller's", async () => {
		// The key resolves to `org-caller`; the project belongs to `org-owner`.
		const res = await patch({ content: ECHOING });

		expect(res.status).toBe(422);
		expect(mocks.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: OWNER_ORG,
			documentType: "PROPOSAL",
		});
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-caller" }),
		);
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: OWNER_ORG }),
		);
	});

	it("leaves a Proposal unchecked when only the caller's organization has the gate on", async () => {
		mocks.isProposalClientDocument.mockImplementation(
			async (args: { organizationId: string | null }) =>
				args.organizationId === "org-caller",
		);

		const res = await patch({ content: CHANGED_DIAGRAM });

		expect(res.status).toBe(200);
		expect(written).toEqual([CHANGED_DIAGRAM]);
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
	});

	it("leaves a Proposal with the gate off unchecked, its write still guarded", async () => {
		mocks.isProposalClientDocument.mockResolvedValue(false);

		const res = await patch({ content: CHANGED_DIAGRAM });

		expect(res.status).toBe(200);
		expect(written).toEqual([CHANGED_DIAGRAM]);
		expect(mocks.listVisualSpecs).not.toHaveBeenCalled();
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
		expect(mocks.updateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({
				expectedVersion: 3,
				expectedContentHash: contentIdentity(STORED),
			}),
		);
	});

	it("leaves a Proposal in a project outside any organization unchecked", async () => {
		mocks.getDocumentById.mockResolvedValue(
			proposalRow({ project: { organizationId: null } }),
		);

		const res = await patch({ content: CHANGED_DIAGRAM });

		expect(res.status).toBe(200);
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
	});

	it("leaves a Technical Spec unchecked, without reading the gate", async () => {
		mocks.getDocumentById.mockResolvedValue(
			proposalRow({ type: "TECHNICAL_SPEC", title: "Technical spec" }),
		);

		const res = await patch({
			content: ECHOING.replace("Delivery", "Go-live"),
		});

		expect(res.status).toBe(200);
		expect(written).toHaveLength(1);
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
	});
});

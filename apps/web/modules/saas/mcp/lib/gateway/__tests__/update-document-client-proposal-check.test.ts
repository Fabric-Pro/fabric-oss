/**
 * `fabric_update_document` on a client-document Proposal is checked like an
 * AI chat accept, stricter on diagrams (Fizzy #2946). Agents holding Fabric's
 * portal tools call this tool too, so it is held to the editor's rules:
 *
 *  - every existing diagram must survive unchanged, even when its section
 *    was removed or renamed (no person reviews this diff), though it may
 *    move: otherwise a tool error with `REVISION_CHANGED_DIAGRAM` that names
 *    the diagram and its section and points at the diagram's Edit with
 *    instructions, and nothing is written;
 *  - the body may not repeat 12+ consecutive words of an answer the session
 *    user was shown as settled: otherwise `RESPONSE_ECHOED`, naming no text;
 *    a session user with no settled block (a project guest) gets the diagram
 *    check alone;
 *  - prose may change anywhere;
 *  - whether the check applies, and whose answers count, is judged by the
 *    project's owning organization, never the session's;
 *  - other document types and Proposals with the gate off are unchanged.
 *
 * `checkPreservation` and `checkResponseEcho` run for real; storage, the gate
 * and the settled-decisions block are faked. `@repo/database` is mocked as in
 * update-document-visual-slots.test.ts.
 *
 * Run with: pnpm vitest run modules/saas/mcp/lib/gateway/__tests__/update-document-client-proposal-check.test.ts
 */

import { contentIdentity } from "@repo/utils/content-identity";
import { SCOPED_REVISION_REFUSAL } from "@repo/utils/proposal-artifact/scoped-revision-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveProjectAccess: vi.fn(),
	hasPermission: vi.fn(),
	updateDocument: vi.fn(),
	getDocumentById: vi.fn(),
	emitDocumentChange: vi.fn(),
	isProposalClientDocument: vi.fn(),
	listVisualSpecs: vi.fn(),
	buildSettledDecisionsBlock: vi.fn(),
}));

vi.mock("@repo/api/lib/realtime", () => ({
	emitDocumentChange: mocks.emitDocumentChange,
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	resolveProjectAccess: mocks.resolveProjectAccess,
	hasPermission: mocks.hasPermission,
	Permissions: {
		PROJECT_UPDATE: "project:update",
		STORY_UPDATE: "story:update",
		CONTEXT_CREATE: "context:create",
		CONTEXT_UPDATE: "context:update",
	},
	updateDocument: mocks.updateDocument,
	getDocumentById: mocks.getDocumentById,
	isProposalClientDocument: mocks.isProposalClientDocument,
	listProposalVisualSpecSummaries: mocks.listVisualSpecs,
	sanitizeContent: (content: string) => content.split("\u0000").join(""),
	IntegrationContractStatusManagedError: class extends Error {},
	DocumentVersionConflictError: class DocumentVersionConflictError extends Error {},
	DocumentGenerationInProgressError: class DocumentGenerationInProgressError extends Error {},
}));

vi.mock(
	"@repo/temporal/proposal-artifact-settled-decisions",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@repo/temporal/proposal-artifact-settled-decisions")
		>()),
		buildSettledDecisionsBlock: mocks.buildSettledDecisionsBlock,
	}),
);

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const MEMBER = "user-member";
const GUEST = "user-guest";
const OWNER_ORG = "org-owner";
/** The session's organization: not the project's. */
const SESSION_ORG = "org-session";

function sessionFor(userId: string): GatewaySession {
	return {
		sessionId: "sess-1",
		userId,
		organizationId: SESSION_ORG,
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "personal-key",
		scopes: ["*"],
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
	};
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

function proposalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc-1",
		projectId: "proj-1",
		type: "PROPOSAL",
		status: "COMPLETE",
		content: STORED,
		version: 3,
		project: { organizationId: OWNER_ORG },
		...overrides,
	};
}

let written: string[];

function update(args: Record<string, unknown>, userId = MEMBER) {
	return executePlatformTool(
		"fabric_update_document",
		{ documentId: "doc-1", ...args },
		sessionFor(userId),
	);
}

function payloadOf(result: { content: Array<{ text?: unknown }> }) {
	return JSON.parse(result.content[0].text as string) as {
		error?: string;
		code?: string;
		diagrams?: Array<Record<string, unknown>>;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	written = [];
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId: OWNER_ORG,
		source: "project-member",
		isVisible: true,
		permissions: ["project:update"],
	});
	mocks.hasPermission.mockImplementation(
		(permissions: string[], required: string) =>
			permissions.includes(required),
	);
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
		async (_id: string, data: { content?: string; title?: string }) => {
			if (data.content !== undefined) {
				written.push(data.content);
			}
			return {
				id: "doc-1",
				title: data.title ?? "Example proposal",
				status: "COMPLETE",
				content: data.content ?? STORED,
				version: 4,
			};
		},
	);
});

describe("fabric_update_document on a client-document Proposal — diagrams", () => {
	it("refuses a changed diagram, naming it and its section, and writes nothing", async () => {
		const result = await update({ content: CHANGED_DIAGRAM });

		expect(result.isError).toBe(true);
		const payload = payloadOf(result);
		expect(payload.code).toBe(SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM);
		expect(payload.diagrams).toEqual([{ diagram: 1, section: "Timeline" }]);
		expect(payload.error).toContain("diagram 1 (under “Timeline”)");
		expect(payload.error).toContain("Edit with instructions in Fabric");
		expect(mocks.listVisualSpecs).toHaveBeenCalledWith({
			organizationId: OWNER_ORG,
			projectId: "proj-1",
			documentId: "doc-1",
		});
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("names a generated diagram's visual id", async () => {
		const marked = withLine(
			"flowchart LR",
			"%% fabric-visual: k3v9q2m7x1a8c4d6\nflowchart LR",
		);
		mocks.getDocumentById.mockResolvedValue(
			proposalRow({ content: marked }),
		);

		const result = await update({
			content: withLine(
				"  Discovery --> Delivery",
				"  Discovery --> Go-live",
				marked,
			),
		});

		expect(result.isError).toBe(true);
		expect(payloadOf(result).diagrams).toEqual([
			{ diagram: 1, section: "Timeline", visualId: "k3v9q2m7x1a8c4d6" },
		]);
	});

	it("refuses a removed diagram whose section stays", async () => {
		const result = await update({
			content: withLine(
				"```mermaid\nflowchart LR\n  Discovery --> Delivery\n```\n\n",
				"",
			),
		});

		expect(result.isError).toBe(true);
		expect(payloadOf(result).code).toBe(
			SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
		);
		expect(written).toEqual([]);
	});

	it("refuses a diagram removed with its whole section, since no person reviews the diff", async () => {
		const withoutTimeline = withLine(
			"## Timeline\n\n```mermaid\nflowchart LR\n  Discovery --> Delivery\n```\n\nThe plan runs in two phases.\n\n",
			"",
		);

		const result = await update({ content: withoutTimeline });

		expect(result.isError).toBe(true);
		const payload = payloadOf(result);
		expect(payload.code).toBe(SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM);
		expect(payload.error).toContain(
			"even when you remove or rename its section",
		);
		expect(payload.error).not.toMatch(/may go/);
		expect(written).toEqual([]);
	});

	it("refuses a changed diagram under a renamed heading, naming its heading as read", async () => {
		const result = await update({ content: RENAMED_CHANGED });

		expect(result.isError).toBe(true);
		const payload = payloadOf(result);
		expect(payload.code).toBe(SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM);
		expect(payload.diagrams).toEqual([{ diagram: 1, section: "Timeline" }]);
		expect(written).toEqual([]);
	});

	it("saves a diagram moved to another section, and a renamed heading", async () => {
		const result = await update({ content: MOVED_DIAGRAM });

		expect(result.isError).toBeUndefined();
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

		const result = await update({
			content: next,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(STORED),
		});

		expect(result.isError).toBeUndefined();
		expect(written).toEqual([next]);
		expect(mocks.listVisualSpecs).not.toHaveBeenCalled();
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
	});

	it("answers a refused change against a body the caller's base no longer names as a stale read", async () => {
		mocks.getDocumentById.mockResolvedValue(proposalRow({ version: 4 }));

		const result = await update({
			content: CHANGED_DIAGRAM,
			expectedVersion: 3,
			expectedContentHash: contentIdentity("# an older body"),
		});

		expect(result.isError).toBe(true);
		const payload = payloadOf(result);
		expect(payload.error).toMatch(/Read it again with fabric_get_document/);
		expect(payload).not.toHaveProperty("code");
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("checks no title-only write", async () => {
		const result = await update({ title: "Proposal for example-org" });

		expect(result.isError).toBeUndefined();
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
	});
});

describe("fabric_update_document on a client-document Proposal — settled answers", () => {
	it("refuses a body that echoes the session user's settled answer, naming no text", async () => {
		const result = await update({ content: ECHOING });

		expect(result.isError).toBe(true);
		const payload = payloadOf(result);
		expect(payload.code).toBe(SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED);
		expect(payload).not.toHaveProperty("diagrams");
		expect(JSON.stringify(result)).not.toContain("discovery workshop");
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

		const result = await update({ content: next });

		expect(result.isError).toBeUndefined();
		expect(written).toEqual([next]);
	});

	it("skips the echo for a project guest, who was carried no answer", async () => {
		const result = await update({ content: ECHOING }, GUEST);

		expect(result.isError).toBeUndefined();
		expect(written).toEqual([ECHOING]);
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith(
			expect.objectContaining({ starterUserId: GUEST }),
		);
	});

	it("still refuses a project guest a changed diagram", async () => {
		const result = await update({ content: CHANGED_DIAGRAM }, GUEST);

		expect(result.isError).toBe(true);
		expect(payloadOf(result).code).toBe(
			SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
		);
		expect(written).toEqual([]);
	});
});

describe("fabric_update_document — what the check applies to", () => {
	it("judges the gate and the answers by the owning organization, not the session's", async () => {
		const result = await update({ content: ECHOING });

		expect(result.isError).toBe(true);
		expect(mocks.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: OWNER_ORG,
			documentType: "PROPOSAL",
		});
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: SESSION_ORG }),
		);
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: OWNER_ORG }),
		);
	});

	it("leaves a Proposal unchecked when only the session's organization has the gate on", async () => {
		mocks.isProposalClientDocument.mockImplementation(
			async (args: { organizationId: string | null }) =>
				args.organizationId === SESSION_ORG,
		);

		const result = await update({ content: CHANGED_DIAGRAM });

		expect(result.isError).toBeUndefined();
		expect(written).toEqual([CHANGED_DIAGRAM]);
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
	});

	it("leaves a Proposal with the gate off unchecked, its write still guarded", async () => {
		mocks.isProposalClientDocument.mockResolvedValue(false);

		const result = await update({ content: CHANGED_DIAGRAM });

		expect(result.isError).toBeUndefined();
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

		const result = await update({ content: CHANGED_DIAGRAM });

		expect(result.isError).toBeUndefined();
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
	});

	it("leaves a Technical Spec unchecked, without reading the gate", async () => {
		mocks.getDocumentById.mockResolvedValue(
			proposalRow({ type: "TECHNICAL_SPEC" }),
		);
		const next = withLine(
			"  Discovery --> Delivery",
			"  Discovery --> Go-live",
			ECHOING,
		);

		const result = await update({ content: next });

		expect(result.isError).toBeUndefined();
		expect(written).toEqual([next]);
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
	});
});

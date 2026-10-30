/**
 * Visual slots survive an MCP document update (Fizzy #2589, KTD17, R39).
 *
 * `fabric_update_document` replaces the whole body with whatever the agent
 * sends, and an agent shown a `<visual-slot>` tag may drop it, echo it, or
 * invent one. The handler strips every slot tag from the incoming body and
 * splices back the slots the stored body holds — the body it already read to
 * authorize the write, never a second read.
 *
 * Each case asserts on the content handed to `updateDocument`. `@repo/database`
 * is mocked the way platform-tool-write-permissions.test.ts mocks it, because
 * the handler reaches it through dynamic `await import(...)`; the slot helper
 * runs for real.
 *
 * Run with: pnpm vitest run modules/saas/mcp/lib/gateway/__tests__/update-document-visual-slots.test.ts
 */

import { contentIdentity } from "@repo/utils/content-identity";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveProjectAccess: vi.fn(),
	hasPermission: vi.fn(),
	updateDocument: vi.fn(),
	getDocumentById: vi.fn(),
	emitDocumentChange: vi.fn(),
	isProposalClientDocument: vi.fn(),
	getProjectAccessContext: vi.fn(),
	buildSettledDecisionsBlock: vi.fn(),
}));

// The AI write check of a client-document Proposal's content write; its
// rules are covered in update-document-client-proposal-check.test.ts.
vi.mock(
	"@repo/temporal/proposal-artifact-settled-decisions",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@repo/temporal/proposal-artifact-settled-decisions")
		>()),
		buildSettledDecisionsBlock: mocks.buildSettledDecisionsBlock,
	}),
);

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
	listProposalVisualSpecSummaries: vi.fn(async () => []),
	sanitizeContent: (content: string) => content,
	getProjectAccessContext: mocks.getProjectAccessContext,
	IntegrationContractStatusManagedError: class extends Error {},
	DocumentVersionConflictError: class DocumentVersionConflictError extends Error {},
	DocumentGenerationInProgressError: class DocumentGenerationInProgressError extends Error {},
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const SLOT =
	'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="Delivery phases"></visual-slot>';

const STORED_WITH_SLOT = [
	"# Proposal",
	"",
	"## Implementation Phases",
	"",
	"Phase one covers discovery.",
	"",
	SLOT,
	"",
	"Phase two covers delivery.",
	"",
	"## Budget",
	"",
	"The budget is fixed.",
].join("\n");

const STORED_WITHOUT_SLOT = [
	"# Proposal",
	"",
	"## Implementation Phases",
	"",
	"Phase one covers discovery.",
	"",
	"Phase two covers delivery.",
	"",
	"## Budget",
	"",
	"The budget is fixed.",
].join("\n");

function storedDocument(content: string) {
	return {
		id: "doc-1",
		projectId: "proj-1",
		type: "PROPOSAL",
		status: "DRAFT",
		content,
		version: 7,
	};
}

function slotCount(markdown: string): number {
	return markdown.match(/<visual-slot\b/g)?.length ?? 0;
}

async function updateContent(content: string): Promise<string> {
	const result = await executePlatformTool(
		"fabric_update_document",
		{ documentId: "doc-1", content },
		session,
	);
	expect(result.isError).toBeUndefined();
	expect(mocks.updateDocument).toHaveBeenCalledTimes(1);
	return mocks.updateDocument.mock.calls[0][1].content;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId: "org-1",
		source: "project-member",
		isVisible: true,
		permissions: ["project:update"],
	});
	mocks.hasPermission.mockImplementation(
		(permissions: string[], required: string) =>
			permissions.includes(required),
	);
	mocks.getDocumentById.mockResolvedValue(storedDocument(STORED_WITH_SLOT));
	mocks.isProposalClientDocument.mockResolvedValue(false);
	mocks.buildSettledDecisionsBlock.mockResolvedValue(null);
	mocks.updateDocument.mockResolvedValue({
		id: "doc-1",
		title: "Proposal",
		status: "DRAFT",
		content: STORED_WITH_SLOT,
		version: 2,
	});
});

describe("fabric_update_document preserves visual slots", () => {
	it("keeps exactly one slot when the agent echoes the stored one", async () => {
		const written = await updateContent(
			STORED_WITH_SLOT.replace(
				"Phase two covers delivery.",
				"Phase two covers delivery and handover.",
			),
		);

		expect(slotCount(written)).toBe(1);
		expect(written).toContain(SLOT);
		expect(written).toContain("Phase two covers delivery and handover.");
	});

	it("keeps the stored slot under its section when the agent drops it", async () => {
		const written = await updateContent(
			STORED_WITHOUT_SLOT.replace(
				"The budget is fixed.",
				"The budget is fixed at the agreed rate.",
			),
		);

		expect(slotCount(written)).toBe(1);
		// Back between the two phase paragraphs, not orphaned to the end.
		expect(written.indexOf(SLOT)).toBeGreaterThan(
			written.indexOf("Phase one covers discovery."),
		);
		expect(written.indexOf(SLOT)).toBeLessThan(
			written.indexOf("Phase two covers delivery."),
		);
		expect(written).toContain("The budget is fixed at the agreed rate.");
		// Spliced from the read that authorized the write, not a second one.
		expect(mocks.getDocumentById).toHaveBeenCalledTimes(1);
	});

	it("does not let an agent add a slot to a document that has none", async () => {
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITHOUT_SLOT),
		);

		const written = await updateContent(STORED_WITH_SLOT);

		expect(slotCount(written)).toBe(0);
		expect(written).toBe(STORED_WITHOUT_SLOT);
	});

	it("writes a slot-free body byte for byte when the stored body has no slot", async () => {
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITHOUT_SLOT),
		);
		const incoming = "# Proposal\r\n\n\n\nTrailing spaces stay.   \n";

		expect(await updateContent(incoming)).toBe(incoming);
	});

	it("leaves the body alone on an update that does not send content", async () => {
		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", title: "Renamed" },
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(mocks.updateDocument.mock.calls[0][1]).not.toHaveProperty(
			"content",
		);
	});
});

// The spliced body is only right for the version its slots came from, so a
// write involving a slot is guarded by that version; slot-free writes are not.
describe("fabric_update_document guards a slot-involving write", () => {
	function writeOptions() {
		return mocks.updateDocument.mock.calls[0][1] as Record<string, unknown>;
	}

	it("writes with the read's version when the stored body holds a slot", async () => {
		await updateContent(STORED_WITHOUT_SLOT);

		expect(writeOptions().expectedVersion).toBe(7);
	});

	it("writes with the read's version when only the incoming body carries a slot tag", async () => {
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITHOUT_SLOT),
		);

		await updateContent(STORED_WITH_SLOT);

		expect(writeOptions().expectedVersion).toBe(7);
	});

	it("keeps the unguarded write when neither body holds a slot", async () => {
		// A PRD: a Proposal's content write is always guarded by its read,
		// for the run that may write its body.
		mocks.getDocumentById.mockResolvedValue({
			...storedDocument(STORED_WITHOUT_SLOT),
			type: "PRD",
		});

		await updateContent(`${STORED_WITHOUT_SLOT}\n\nOne more line.`);

		expect(writeOptions()).not.toHaveProperty("expectedVersion");
	});

	it("tells the agent to read again when the document moved under the write", async () => {
		const { DocumentVersionConflictError } = await import("@repo/database");
		mocks.updateDocument.mockRejectedValue(
			new DocumentVersionConflictError(),
		);

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: STORED_WITHOUT_SLOT },
			session,
		);

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(
			/changed while it was being updated/,
		);
	});
});

// Open editors refetch on `document_change`, so a collaborative room holding
// the body an agent's write replaced brings itself to the saved one instead
// of saving the older body back (Fizzy #2946).
describe("fabric_update_document nudges open editors", () => {
	beforeEach(() => {
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITHOUT_SLOT),
		);
		mocks.emitDocumentChange.mockResolvedValue(undefined);
	});

	it("emits document_change once after a content write", async () => {
		await updateContent(`${STORED_WITHOUT_SLOT}\n\nOne more line.`);

		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
		expect(mocks.emitDocumentChange).toHaveBeenCalledWith({
			projectId: "proj-1",
			documentId: "doc-1",
			action: "updated",
			userId: "user-1",
			userName: "Example Agent",
			documentType: "PROPOSAL",
			documentTitle: "Proposal",
		});
	});

	it("emits after a title-only write too, as the editor's own save does", async () => {
		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", title: "Proposal for example-org" },
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
	});

	it("emits nothing when the write was refused", async () => {
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITH_SLOT),
		);
		const { DocumentVersionConflictError } = await import("@repo/database");
		mocks.updateDocument.mockRejectedValue(
			new DocumentVersionConflictError("doc-1", 7, 8),
		);

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: STORED_WITH_SLOT },
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});
});

// A generated diagram the agent left unchanged keeps its marker line, so its
// stored spec stays referenced (Fizzy #2946).
describe("fabric_update_document preserves generated diagram markers", () => {
	const MARKER = "%% fabric-visual: k3v9q2m7x1a8c4d6";
	const diagram = (marker: boolean, label = "Launch") =>
		[
			"```mermaid",
			...(marker ? [MARKER] : []),
			"flowchart LR",
			`  s0["Discovery"] --> s1["${label}"]`,
			"```",
		].join("\n");
	const body = (fence: string, intro = "Phase one covers discovery.") =>
		[
			"# Proposal",
			"",
			"## Implementation Phases",
			"",
			intro,
			"",
			fence,
			"",
		].join("\n");

	beforeEach(() => {
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(body(diagram(true))),
		);
	});

	it("puts back the marker of an unchanged diagram and keeps the rest as sent", async () => {
		const written = await updateContent(
			body(diagram(false), "Phase one covers discovery and design."),
		);

		expect(written).toBe(
			body(diagram(true), "Phase one covers discovery and design."),
		);
	});

	it("adds no marker to a diagram whose body changed", async () => {
		const incoming = body(diagram(false, "Go-live"));

		expect(await updateContent(incoming)).toBe(incoming);
	});
});

describe("fabric_get_document description", () => {
	it("tells agents a visual slot is a placeholder marker, not prose", () => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find(
			(definition) => definition.name === "fabric_get_document",
		);

		expect(tool?.description).toContain("<visual-slot");
		expect(tool?.description).toMatch(/placeholder marker/);
		expect(tool?.description).toMatch(/not prose/);
	});
});

describe("fabric_update_document content description", () => {
	it("tells agents that slot tags they send are ignored", () => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find(
			(definition) => definition.name === "fabric_update_document",
		);
		const content = (
			tool?.inputSchema as {
				properties: { content: { description: string } };
			}
		).properties.content.description;

		expect(content).toContain("<visual-slot");
		expect(content).toMatch(/kept in place/);
		expect(content).toMatch(/ignored/);
	});

	it("tells agents a generated diagram's marker survives only an unchanged body", () => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find(
			(definition) => definition.name === "fabric_update_document",
		);
		const content = (
			tool?.inputSchema as {
				properties: { content: { description: string } };
			}
		).properties.content.description;

		expect(tool?.description).toContain("%% fabric-visual:");
		expect(tool?.description).toMatch(/never invent or copy/);
		expect(tool?.description).toMatch(/body is unchanged/);
		expect(content).toMatch(/changed mermaid body loses its marker/);
	});
});

// An agent reads a document, then writes it back. The read names its base
// (`version`, `contentHash`); a write may send it back, and a client-document
// Proposal's content write is guarded by the body the call read even when it
// does not, so a generated body landing in between is never overwritten
// (Fizzy #2946).
describe("fabric_get_document returns the document's base", () => {
	it("returns the version and the body identity", async () => {
		mocks.getProjectAccessContext.mockResolvedValue({
			organizationId: "org-1",
		});
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITHOUT_SLOT),
		);

		const result = await executePlatformTool(
			"fabric_get_document",
			{ documentId: "doc-1" },
			session,
		);

		expect(result.isError).toBeUndefined();
		const payload = JSON.parse(
			(result.content[0] as { text: string }).text,
		) as { version: number; contentHash: string };
		expect(payload.version).toBe(7);
		expect(payload.contentHash).toBe(contentIdentity(STORED_WITHOUT_SLOT));
	});
});

describe("fabric_update_document honours a base", () => {
	const GENERATED_BODY = "# Proposal\n\nThe body a generation run saved.";

	// Stands in for the query layer's guard: a write that names a base is
	// refused unless the stored document still matches it.
	let stored: { content: string; version: number };
	let written: string[];

	function proposalRow(overrides: Record<string, unknown> = {}) {
		return {
			...storedDocument(STORED_WITHOUT_SLOT),
			project: { organizationId: "org-owner" },
			...overrides,
		};
	}

	function writeOptions() {
		return mocks.updateDocument.mock.calls[0][1] as Record<string, unknown>;
	}

	beforeEach(async () => {
		const { DocumentVersionConflictError } = await import("@repo/database");
		stored = { content: STORED_WITHOUT_SLOT, version: 7 };
		written = [];
		mocks.emitDocumentChange.mockResolvedValue(undefined);
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITHOUT_SLOT),
		);
		mocks.updateDocument.mockImplementation(
			async (
				_id: string,
				data: {
					content?: string;
					expectedVersion?: number;
					expectedContentHash?: string;
				},
			) => {
				if (
					(data.expectedVersion !== undefined &&
						data.expectedVersion !== stored.version) ||
					(data.expectedContentHash !== undefined &&
						data.expectedContentHash !==
							contentIdentity(stored.content))
				) {
					throw new DocumentVersionConflictError();
				}
				if (data.content !== undefined) {
					written.push(data.content);
					stored = {
						content: data.content,
						version: stored.version + 1,
					};
				}
				return {
					id: "doc-1",
					title: "Proposal",
					status: "DRAFT",
					content: stored.content,
					version: stored.version,
				};
			},
		);
	});

	it("passes the caller's base to the write", async () => {
		const result = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# Edited",
				expectedVersion: 7,
				expectedContentHash: contentIdentity(STORED_WITHOUT_SLOT),
			},
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(writeOptions().expectedVersion).toBe(7);
		expect(writeOptions().expectedContentHash).toBe(
			contentIdentity(STORED_WITHOUT_SLOT),
		);
	});

	it("returns the saved base, so a second guarded update chains from it without a read", async () => {
		const first = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# First edit",
				expectedVersion: 7,
				expectedContentHash: contentIdentity(STORED_WITHOUT_SLOT),
			},
			session,
		);
		expect(first.isError).toBeUndefined();
		const firstResult = JSON.parse(first.content[0].text as string);
		expect(firstResult).toMatchObject({
			version: 8,
			contentHash: contentIdentity("# First edit"),
		});

		const second = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# Second edit",
				expectedVersion: firstResult.version,
				expectedContentHash: firstResult.contentHash,
			},
			session,
		);

		expect(second.isError).toBeUndefined();
		expect(written).toEqual(["# First edit", "# Second edit"]);
		expect(mocks.getDocumentById).toHaveBeenCalledTimes(2);
	});

	it("treats a null base as no base", async () => {
		// A PRD: a Proposal without a base is guarded by its read instead.
		mocks.getDocumentById.mockResolvedValue({
			...storedDocument(STORED_WITHOUT_SLOT),
			type: "PRD",
		});

		const result = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# Edited",
				expectedVersion: null,
				expectedContentHash: null,
			},
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(writeOptions()).not.toHaveProperty("expectedVersion");
		expect(writeOptions()).not.toHaveProperty("expectedContentHash");
		expect(written).toEqual(["# Edited"]);
	});

	it("still rejects a null half beside a real one", async () => {
		const result = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# Edited",
				expectedVersion: 7,
				expectedContentHash: null,
			},
			session,
		);

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/both expectedVersion/);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("refuses a stale base and writes nothing", async () => {
		stored = { content: "# A newer save", version: 8 };

		const result = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# Edited",
				expectedVersion: 7,
				expectedContentHash: contentIdentity(STORED_WITHOUT_SLOT),
			},
			session,
		);

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/Read it again/);
		expect(written).toEqual([]);
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("rejects a malformed base before writing", async () => {
		const badVersion = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# Edited",
				expectedVersion: "7",
				expectedContentHash: contentIdentity(STORED_WITHOUT_SLOT),
			},
			session,
		);
		const badHash = await executePlatformTool(
			"fabric_update_document",
			{
				documentId: "doc-1",
				content: "# Edited",
				expectedVersion: 7,
				expectedContentHash: 1,
			},
			session,
		);

		expect(badVersion.isError).toBe(true);
		expect(badHash.isError).toBe(true);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it.each([
		["only a version", { expectedVersion: 7 }],
		[
			"only a body identity",
			{ expectedContentHash: contentIdentity(STORED_WITHOUT_SLOT) },
		],
	])("rejects half a base: %s", async (_name, base) => {
		mocks.isProposalClientDocument.mockResolvedValue(true);
		mocks.getDocumentById.mockResolvedValue(proposalRow());

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: "# Agent rewrite", ...base },
			session,
		);

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/both expectedVersion/);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	// The gate's state must not matter: a run already in progress keeps
	// writing after the Proposal gate is turned off.
	it.each([
		["QUEUED", true],
		["GENERATING", true],
		["QUEUED", false],
		["GENERATING", false],
	])(
		"refuses a Proposal content write while it is %s (Proposal gate on: %s)",
		async (status, gateOn) => {
			mocks.isProposalClientDocument.mockResolvedValue(gateOn);
			mocks.getDocumentById.mockResolvedValue(proposalRow({ status }));

			const result = await executePlatformTool(
				"fabric_update_document",
				{ documentId: "doc-1", content: "# Agent rewrite" },
				session,
			);

			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toMatch(
				/generation run is writing this document/,
			);
			expect(mocks.updateDocument).not.toHaveBeenCalled();
			expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		},
	);

	// The gate's state must not matter: a run already in progress keeps
	// writing after the Proposal gate is turned off.
	it.each([
		["QUEUED", true],
		["GENERATING", true],
		["QUEUED", false],
		["GENERATING", false],
	])(
		"refuses a Proposal status-only write while it is %s (Proposal gate on: %s)",
		async (status, gateOn) => {
			mocks.isProposalClientDocument.mockResolvedValue(gateOn);
			mocks.getDocumentById.mockResolvedValue(proposalRow({ status }));

			const result = await executePlatformTool(
				"fabric_update_document",
				{ documentId: "doc-1", status: "COMPLETE" },
				session,
			);

			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toMatch(
				/generation run is writing this document/,
			);
			expect(mocks.updateDocument).not.toHaveBeenCalled();
			expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		},
	);

	it("does not let a status write end a run's hold so a content write can follow", async () => {
		const { DocumentGenerationInProgressError } = await import(
			"@repo/database"
		);
		// Stands in for the stored row and the query layer's run guard.
		let storedStatus = "GENERATING";
		mocks.isProposalClientDocument.mockResolvedValue(true);
		mocks.getDocumentById.mockImplementation(async () =>
			proposalRow({ status: storedStatus }),
		);
		mocks.updateDocument.mockImplementation(
			async (
				_id: string,
				data: {
					content?: string;
					status?: string;
					allowDuringLiveRun?: string;
				},
			) => {
				// The stored row is a Proposal: the query refuses its content
				// and status writes under a run unless the write is exempt.
				if (
					(data.content !== undefined || data.status !== undefined) &&
					data.allowDuringLiveRun === undefined &&
					(storedStatus === "QUEUED" || storedStatus === "GENERATING")
				) {
					throw new DocumentGenerationInProgressError();
				}
				if (data.status !== undefined) {
					storedStatus = data.status;
				}
				if (data.content !== undefined) {
					written.push(data.content);
				}
				return {
					id: "doc-1",
					title: "Proposal",
					status: storedStatus,
					content: stored.content,
					version: stored.version,
				};
			},
		);

		const statusResult = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", status: "COMPLETE" },
			session,
		);
		const contentResult = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: "# Agent rewrite" },
			session,
		);

		expect(statusResult.isError).toBe(true);
		expect(contentResult.isError).toBe(true);
		expect(storedStatus).toBe("GENERATING");
		expect(written).toEqual([]);
	});

	it("leaves a status-only write to the write's refusal of a run queued after the read", async () => {
		const { DocumentGenerationInProgressError } = await import(
			"@repo/database"
		);
		mocks.isProposalClientDocument.mockResolvedValue(true);
		mocks.getDocumentById.mockResolvedValue(proposalRow());
		mocks.updateDocument.mockRejectedValue(
			new DocumentGenerationInProgressError(),
		);

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", status: "COMPLETE" },
			session,
		);

		expect(writeOptions().status).toBe("COMPLETE");
		// Never exempt: the query refuses it under a run by default.
		expect(writeOptions()).not.toHaveProperty("allowDuringLiveRun");
		// A status-only write carries no body, so it names no body base.
		expect(writeOptions()).not.toHaveProperty("expectedContentHash");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(
			/generation run is writing this document/,
		);
	});

	it("leaves a status-only write to a non-Proposal document unguarded during a run", async () => {
		mocks.getDocumentById.mockResolvedValue({
			...storedDocument(STORED_WITHOUT_SLOT),
			type: "PRD",
			status: "GENERATING",
		});

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", status: "COMPLETE" },
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(writeOptions().status).toBe("COMPLETE");
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
	});

	it("reports the write's refusal of a run queued after the read as a live run", async () => {
		const { DocumentGenerationInProgressError } = await import(
			"@repo/database"
		);
		mocks.isProposalClientDocument.mockResolvedValue(true);
		mocks.getDocumentById.mockResolvedValue(proposalRow());
		mocks.updateDocument.mockRejectedValue(
			new DocumentGenerationInProgressError(),
		);

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: "# Agent rewrite" },
			session,
		);

		expect(writeOptions()).not.toHaveProperty("allowDuringLiveRun");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(
			/generation run is writing this document/,
		);
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("guards a finished Proposal's write with the Proposal gate off", async () => {
		mocks.isProposalClientDocument.mockResolvedValue(false);
		mocks.getDocumentById.mockResolvedValue(proposalRow());

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: "# Agent rewrite" },
			session,
		);

		expect(result.isError).toBeUndefined();
		// The gate is read for the AI write check only, which a gate-off
		// Proposal skips; the guard is the same either way.
		expect(mocks.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: "org-owner",
			documentType: "PROPOSAL",
		});
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
		expect(writeOptions().expectedVersion).toBe(7);
		expect(writeOptions().expectedContentHash).toBe(
			contentIdentity(STORED_WITHOUT_SLOT),
		);
	});

	it("guards a client-document Proposal write without a base by the body it read", async () => {
		mocks.isProposalClientDocument.mockResolvedValue(true);
		mocks.getDocumentById.mockImplementation(async () => {
			const row = proposalRow();
			// A run's final save lands after the read, at the same version.
			stored = { content: GENERATED_BODY, version: 7 };
			return row;
		});

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: "# Agent rewrite" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/Read it again/);
		expect(written).toEqual([]);
		expect(stored.content).toBe(GENERATED_BODY);
		expect(writeOptions().expectedVersion).toBe(7);
		expect(writeOptions().expectedContentHash).toBe(
			contentIdentity(STORED_WITHOUT_SLOT),
		);
	});

	it("lets a client-document Proposal title change through during a run", async () => {
		mocks.isProposalClientDocument.mockResolvedValue(true);
		mocks.getDocumentById.mockResolvedValue(
			proposalRow({ status: "GENERATING" }),
		);

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", title: "Proposal for example-org" },
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(writeOptions()).not.toHaveProperty("expectedContentHash");
	});

	it("keeps a PRD write without a base unguarded", async () => {
		mocks.getDocumentById.mockResolvedValue({
			...storedDocument(STORED_WITHOUT_SLOT),
			type: "PRD",
		});

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", content: "# Edited" },
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(writeOptions()).not.toHaveProperty("expectedVersion");
		expect(writeOptions()).not.toHaveProperty("expectedContentHash");
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalled();
		expect(written).toEqual(["# Edited"]);
	});
});

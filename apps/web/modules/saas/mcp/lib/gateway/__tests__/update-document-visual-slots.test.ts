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

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveProjectAccess: vi.fn(),
	hasPermission: vi.fn(),
	updateDocument: vi.fn(),
	getDocumentById: vi.fn(),
}));

vi.mock("@repo/database", () => ({
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
	IntegrationContractStatusManagedError: class extends Error {},
	DocumentVersionConflictError: class DocumentVersionConflictError extends Error {},
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
	mocks.updateDocument.mockResolvedValue({
		id: "doc-1",
		title: "Proposal",
		status: "DRAFT",
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
		mocks.getDocumentById.mockResolvedValue(
			storedDocument(STORED_WITHOUT_SLOT),
		);

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
});

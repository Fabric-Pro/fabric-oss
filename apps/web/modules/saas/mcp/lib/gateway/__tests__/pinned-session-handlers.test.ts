/**
 * A pinned service session reaches one project through the handlers too: a
 * document or a context that resolves to another project is refused before the
 * person's permissions there are asked, though the person may read both, and
 * the meeting's own project is served.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: async () => ({
		availability: "UPLOAD",
		readState: "DIRECT",
	}),
}));
vi.mock("@repo/api/lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: async () => ({ permissions: [] }),
}));

const mocks = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	getDocumentById: vi.fn(),
	getContextById: vi.fn(),
	resolveProjectAccess: vi.fn(),
	updateDocument: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	getProjectAccessContext: mocks.getProjectAccessContext,
	getDocumentById: mocks.getDocumentById,
	getContextById: mocks.getContextById,
	resolveProjectAccess: mocks.resolveProjectAccess,
	updateDocument: mocks.updateDocument,
	DocumentVersionConflictError: class extends Error {},
	DocumentGenerationInProgressError: class extends Error {},
	IntegrationContractStatusManagedError: class extends Error {},
	readProjectContextBodyPage: vi.fn(),
	hasPermission: () => true,
	Permissions: {
		INSTRUCTION_READ: "instruction:read",
		PROJECT_UPDATE: "project:update",
		STORY_UPDATE: "story:update",
		CONTEXT_CREATE: "context:create",
		CONTEXT_UPDATE: "context:update",
	},
}));

import { PARLUME_GRANT_SCOPES } from "@repo/api/lib/agent-service-auth";
import { executePlatformTool } from "../platform-tools";
import { serviceSessionScopes } from "../tool-scope";
import type { GatewaySession } from "../types";

const ORG = "org-example-alpha";
const PINNED = "project-example-one";
const OTHER = "project-example-two";

function pinned(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		sessionId: "session-1",
		userId: "user-1",
		organizationId: ORG,
		projectId: null,
		pinnedProjectId: PINNED,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential: "service",
		scopes: serviceSessionScopes({
			projectId: PINNED,
			scopes: PARLUME_GRANT_SCOPES,
		}),
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
		...overrides,
	};
}

function text(result: { content: Array<{ text: string }> }): string {
	return result.content.map((part) => part.text).join("\n");
}

const document = (projectId: string) => ({
	id: "d1",
	projectId,
	type: "PRD",
	title: "Plan",
	content: "the body",
	status: "COMPLETE",
	version: 1,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProjectAccessContext.mockResolvedValue({ organizationId: ORG });
	mocks.resolveProjectAccess.mockResolvedValue({
		isVisible: true,
		source: "owner",
		permissions: [],
		organizationId: ORG,
	});
});

describe("a pinned service session's handlers", () => {
	it("refuses a document of another project, though the person may read both", async () => {
		mocks.getDocumentById.mockResolvedValue(document(OTHER));

		const result = await executePlatformTool(
			"fabric_get_document",
			{ documentId: "d1" },
			pinned(),
		);

		expect(result.isError).toBe(true);
		expect(text(result)).not.toContain("the body");
		expect(mocks.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("serves a document of the meeting's own project", async () => {
		mocks.getDocumentById.mockResolvedValue(document(PINNED));

		const result = await executePlatformTool(
			"fabric_get_document",
			{ documentId: "d1" },
			pinned(),
		);

		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("the body");
	});

	it("refuses to write a document of another project before asking what the person may do there", async () => {
		mocks.getDocumentById.mockResolvedValue(document(OTHER));

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "d1", content: "rewritten" },
			pinned(),
		);

		expect(result.isError).toBe(true);
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("refuses a context of another project", async () => {
		mocks.getContextById.mockResolvedValue({
			id: "c1",
			projectId: OTHER,
			type: "FILE",
			title: "Notes",
		});

		const result = await executePlatformTool(
			"fabric_get_project_context",
			{ contextId: "c1" },
			pinned(),
		);

		expect(result.isError).toBe(true);
		expect(mocks.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses a portal tool the session's scopes do not reach", async () => {
		const result = await executePlatformTool(
			"fabric_get_document",
			{ documentId: "d1" },
			pinned({ scopes: ["workflows:read"] }),
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("projects:read");
	});
});

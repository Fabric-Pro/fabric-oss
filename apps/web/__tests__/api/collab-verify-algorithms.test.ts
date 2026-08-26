// @vitest-environment node
// These exercise server route handlers, and `jose` rejects the Uint8Array
// jsdom's TextEncoder returns (different realm), so run them in node.

/**
 * `POST /api/collab/verify` after pinning `algorithms: ["HS256"]` (issue #624).
 *
 * Regression guard for the document-collab path, which the orchestrator and
 * task-agent live routes were modelled on: existing 1-hour collab tokens must
 * keep verifying (no audience was added, deliberately — pinning one would 401
 * in-flight tokens during a rolling deploy), while a token signed with another
 * HMAC algorithm is now refused.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { bearerPost, signLiveToken } from "./helpers/live-jwt";

const SECRET = "test-collab-jwt-secret-for-collab-verify";
const DOCUMENT_ID = "doc-1";
const VERIFY_URL = "https://example.test/api/collab/verify";

const { mockGetDocumentById, mockHasAccess, mockCanEdit } = vi.hoisted(() => ({
	mockGetDocumentById: vi.fn(),
	mockHasAccess: vi.fn(),
	mockCanEdit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getDocumentById: mockGetDocumentById,
	hasProjectAccess: mockHasAccess,
	canEditProject: mockCanEdit,
}));

async function callRoute(token: string) {
	const { POST } = await import("../../app/api/collab/verify/route");
	return POST(bearerPost(VERIFY_URL, token, { documentId: DOCUMENT_ID }));
}

describe("POST /api/collab/verify", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.COLLAB_JWT_SECRET = SECRET;
		mockGetDocumentById.mockResolvedValue({
			id: DOCUMENT_ID,
			projectId: "project-1",
		});
		mockHasAccess.mockResolvedValue(true);
		mockCanEdit.mockResolvedValue(true);
	});

	it("still accepts an audience-less HS256 collab token", async () => {
		const token = await signLiveToken(
			{
				userId: "user-1",
				userName: "Ada",
				documentId: DOCUMENT_ID,
				projectId: "project-1",
				canEdit: true,
			},
			{ secret: SECRET, expirationTime: "1h" },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			valid: true,
			userId: "user-1",
			canEdit: true,
		});
	});

	it("500s when COLLAB_JWT_SECRET is not configured", async () => {
		process.env.COLLAB_JWT_SECRET = "";

		const token = await signLiveToken(
			{ userId: "user-1", documentId: DOCUMENT_ID },
			{ secret: SECRET, expirationTime: "1h" },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Server configuration error",
		});
		expect(mockGetDocumentById).not.toHaveBeenCalled();
	});

	it("refuses a token signed with a different HMAC algorithm", async () => {
		const token = await signLiveToken(
			{ userId: "user-1", documentId: DOCUMENT_ID },
			{ secret: SECRET, expirationTime: "1h", alg: "HS512" },
		);

		const response = await callRoute(token);

		expect(response.status).toBe(401);
		expect(mockGetDocumentById).not.toHaveBeenCalled();
	});
});

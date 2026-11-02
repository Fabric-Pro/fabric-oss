import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, getSignedUrlMock, resolveChatMediaAccessMock } =
	vi.hoisted(() => ({
		getSessionMock: vi.fn(),
		getSignedUrlMock: vi.fn(),
		resolveChatMediaAccessMock: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	resolveChatMediaAccess: resolveChatMediaAccessMock,
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { chatDocuments: "example-chat-documents" } },
	},
}));

vi.mock("@repo/storage", () => ({
	getSignedUrl: getSignedUrlMock,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: getSessionMock,
}));

import { GET } from "../route";

const USER_ID = "example-user";
const ORGANIZATION_ID = "example-org";
const CHAT_IMAGE_PATH = `${ORGANIZATION_ID}/chat-images/1700000000000-abc123xy.png`;
const GENERATED_IMAGE_PATH = `${ORGANIZATION_ID}/generated-images/1700000000001-def456yz.jpeg`;
const TTS_AUDIO_PATH = `${ORGANIZATION_ID}/tts-audio/1794000000002-ghi789ab.mp3`;

function makeRequest(path: string, orgId?: string): NextRequest {
	const url = new URL("https://example.com/api/storage/image");
	url.searchParams.set("path", path);
	if (orgId) {
		url.searchParams.set("orgId", orgId);
	}
	return { nextUrl: url } as NextRequest;
}

function makeEncodedRequest(encodedPath: string, orgId: string): NextRequest {
	const url = new URL(
		`https://example.com/api/storage/image?path=${encodedPath}&orgId=${encodeURIComponent(orgId)}`,
	);
	return { nextUrl: url } as NextRequest;
}

describe("GET /api/storage/image", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: ORGANIZATION_ID },
		});
		getSignedUrlMock.mockResolvedValue(
			"https://storage.example.com/signed-image",
		);
		resolveChatMediaAccessMock.mockResolvedValue("allow");
	});

	it("refuses a peer's chat-document-shaped path in the active organization", async () => {
		const response = await GET(
			makeRequest(
				`${ORGANIZATION_ID}/chat-123/document-456.png`,
				ORGANIZATION_ID,
			),
		);

		expect(response.status).toBe(403);
		expect(getSignedUrlMock).not.toHaveBeenCalled();
	});

	it("signs an uploaded chat image under the active organization", async () => {
		const response = await GET(
			makeRequest(CHAT_IMAGE_PATH, ORGANIZATION_ID),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://storage.example.com/signed-image",
		);
		expect(getSignedUrlMock).toHaveBeenCalledWith(CHAT_IMAGE_PATH, {
			bucket: "example-chat-documents",
			expiresIn: 3600,
		});
	});

	it("signs a generated image for a permitted organization viewer", async () => {
		const response = await GET(
			makeRequest(GENERATED_IMAGE_PATH, ORGANIZATION_ID),
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://storage.example.com/signed-image",
		);
		expect(getSignedUrlMock).toHaveBeenCalledWith(GENERATED_IMAGE_PATH, {
			bucket: "example-chat-documents",
			expiresIn: 3600,
		});
	});

	it("signs a recorded TTS audio object for its owner", async () => {
		const response = await GET(
			makeRequest(TTS_AUDIO_PATH, ORGANIZATION_ID),
		);

		expect(response.status).toBe(302);
		expect(resolveChatMediaAccessMock).toHaveBeenCalledWith({
			storageKey: TTS_AUDIO_PATH,
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
		});
		expect(getSignedUrlMock).toHaveBeenCalledWith(TTS_AUDIO_PATH, {
			bucket: "example-chat-documents",
			expiresIn: 3600,
		});
	});

	it.each([
		["recorded and allowed after the cutoff", "allow", TTS_AUDIO_PATH, 302],
		[
			"recorded but denied before the cutoff",
			"deny",
			`${ORGANIZATION_ID}/generated-images/1794000000000-abc123xy.png`,
			403,
		],
		[
			"unrecorded legacy object before the cutoff",
			"legacy",
			`${ORGANIZATION_ID}/generated-images/1794000000000-def456yz.png`,
			302,
		],
		[
			"unrecorded object after the cutoff",
			"deny",
			`${ORGANIZATION_ID}/generated-images/1794200000000-def456yz.png`,
			403,
		],
	] as const)("handles a %s", async (_case, decision, path, status) => {
		resolveChatMediaAccessMock.mockResolvedValue(decision);

		const response = await GET(makeRequest(path, ORGANIZATION_ID));

		expect(response.status).toBe(status);
		expect(getSignedUrlMock).toHaveBeenCalledTimes(status === 302 ? 1 : 0);
	});

	it.each([
		["an extra segment", `${CHAT_IMAGE_PATH}/nested`],
		["an empty segment", `${CHAT_IMAGE_PATH}/`],
		["traversal segments", `${CHAT_IMAGE_PATH}/..`],
	])("refuses a path with %s", async (_description, path) => {
		const response = await GET(makeRequest(path, ORGANIZATION_ID));

		expect(response.status).toBe(403);
		expect(getSignedUrlMock).not.toHaveBeenCalled();
	});

	it("refuses an encoded slash that introduces another segment", async () => {
		const response = await GET(
			makeEncodedRequest(
				`${encodeURIComponent(CHAT_IMAGE_PATH)}%2Fnested.png`,
				ORGANIZATION_ID,
			),
		);

		expect(response.status).toBe(403);
		expect(getSignedUrlMock).not.toHaveBeenCalled();
	});

	it("refuses a three-segment path with a non-image kind", async () => {
		const response = await GET(
			makeRequest(
				`${ORGANIZATION_ID}/private-files/1700000000000-abc123xy.png`,
				ORGANIZATION_ID,
			),
		);

		expect(response.status).toBe(403);
		expect(getSignedUrlMock).not.toHaveBeenCalled();
	});

	it.each([
		"image.png",
		"not-a-timestamp-abc123xy.png",
		"1700000000000-ABC123XY.png",
		"1700000000000-abc123xy",
		"1700000000000-abc123xy.tar.png",
		"1700000000000-.png",
		"..",
		"doc_1700000000000-abc123xy.png",
	])("refuses the bad image filename %s", async (filename) => {
		const response = await GET(
			makeRequest(
				`${ORGANIZATION_ID}/chat-images/${filename}`,
				ORGANIZATION_ID,
			),
		);

		expect(response.status).toBe(403);
		expect(getSignedUrlMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"an explicit organization that is not active",
			CHAT_IMAGE_PATH,
			"other-org",
		],
		[
			"a path outside the explicit organization",
			"other-org/chat-images/1700000000000-abc123xy.png",
			ORGANIZATION_ID,
		],
		[
			"a path outside the user or active organization",
			"other-owner/chat-images/1700000000000-abc123xy.png",
			undefined,
		],
	])(
		"preserves the prefix refusal for %s",
		async (_description, path, orgId) => {
			const response = await GET(makeRequest(path, orgId));

			expect(response.status).toBe(403);
			expect(getSignedUrlMock).not.toHaveBeenCalled();
		},
	);
});

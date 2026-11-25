import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../route";

const mocks = vi.hoisted(() => ({
	document: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	upload: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: async () => ({
		valid: true,
		claims: { sub: "example-user", org: "example-org" },
	}),
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectDocumentAssets: "example-bucket" } },
	},
}));
vi.mock("@repo/database", () => ({
	db: {
		projectDocument: { findUnique: mocks.document },
		projectDocumentAsset: { create: mocks.create, update: mocks.update },
	},
}));
vi.mock("@repo/storage", () => ({
	ensureBuckets: async () => undefined,
	uploadFile: mocks.upload,
}));

function document(deletedAt: Date | null) {
	return {
		id: "example-document",
		userId: "example-owner",
		organizationId: "example-org",
		project: { organization: { deletedAt } },
	};
}

function upload() {
	return POST(
		new Request("https://example.com/api/internal/document-assets", {
			method: "POST",
			headers: { "X-AI-Token": "example-token" },
			body: JSON.stringify({
				documentId: "example-document",
				filename: "example.txt",
				contentType: "text/plain",
				content: "Example asset",
			}),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.document.mockResolvedValue(document(null));
	mocks.create.mockResolvedValue({ id: "example-asset" });
});

it("writes an asset for the token's live project organization", async () => {
	const response = await upload();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ assetId: "example-asset" });
	expect(mocks.upload).toHaveBeenCalledOnce();
});

it("refuses a deleted project organization before writing an asset", async () => {
	mocks.document.mockResolvedValue(document(new Date()));
	expect((await upload()).status).toBe(403);
	expect(mocks.create).not.toHaveBeenCalled();
	expect(mocks.upload).not.toHaveBeenCalled();
});

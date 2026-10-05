/**
 * GitLab sync uploads and downloads go to the connection's instance with its
 * token. That instance is user-supplied for self-hosted GitLab, so an
 * internal address is refused before any request leaves, and a public
 * self-hosted instance is reached through the outbound guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => ({
		data: Buffer.from([1, 2, 3]),
		contentType: "application/pdf",
		size: 3,
	})),
	getStorageProvider: vi.fn(),
}));

import { createGitLabAttachmentAdapter } from "../gitlab-attachment-adapter";
import {
	uploadGitLabFileAttachmentsAndRewrite,
	uploadGitLabImagesAndRewriteDescription,
} from "../story-sync-media";

const SECRET = "c".repeat(32);
const INTERNAL = [
	"https://169.254.169.254",
	"https://127.0.0.1",
	"https://10.0.0.5",
];

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify({ url: `/uploads/${SECRET}/a.png` }), {
			status: 201,
			headers: { "content-type": "application/json" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each(INTERNAL)("an internal instance %s", (baseUrl) => {
	it("attachment upload and download send nothing", async () => {
		const adapter = createGitLabAttachmentAdapter({
			token: "tok",
			projectId: "group/proj",
			baseUrl,
		});

		await expect(
			adapter.upload({
				storageKey: "k",
				filename: "spec.pdf",
				mimeType: "application/pdf",
			}),
		).rejects.toThrow();
		await expect(
			adapter.download({ secret: SECRET, filename: "spec.pdf" }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("description image and file uploads send nothing", async () => {
		const png = "data:image/png;base64,iVBORw0KGgo=";
		await uploadGitLabImagesAndRewriteDescription(`![a](${png})`, {
			token: "tok",
			projectId: "group/proj",
			baseUrl,
		});
		await uploadGitLabFileAttachmentsAndRewrite(`[spec](${png})`, {
			token: "tok",
			projectId: "group/proj",
			baseUrl,
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("a public self-hosted instance", () => {
	it("is reached through the outbound guard", async () => {
		const adapter = createGitLabAttachmentAdapter({
			token: "tok",
			projectId: "group/proj",
			baseUrl: "https://gitlab.example.com",
		});

		await adapter.upload({
			storageKey: "k",
			filename: "spec.pdf",
			mimeType: "application/pdf",
		});

		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit & { dispatcher?: unknown },
		];
		expect(url).toBe(
			"https://gitlab.example.com/api/v4/projects/group%2Fproj/uploads",
		);
		expect(init.dispatcher).toBeDefined();
		expect(init.redirect).toBe("error");
	});
});

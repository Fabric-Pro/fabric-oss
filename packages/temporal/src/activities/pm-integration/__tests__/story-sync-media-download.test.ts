import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { config } from "@repo/config";
import { logger } from "@repo/logs";
import {
	OutboundResponseRejectedError,
	safeFetchOutboundPinned,
	UnsafeOutboundUrlError,
} from "@repo/utils/url-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchImageAsBase64DataUrl,
	inlineJiraMarkdownImagesAsBase64DataUrls,
	resolveFizzyFileEmbeds,
	uploadAdoImageAttachments,
	uploadFizzyImageAttachments,
	uploadGitLabFileAttachmentsAndRewrite,
	uploadGitLabImagesAndRewriteDescription,
	uploadJiraImagesAndRewriteDescription,
	uploadOneImageToJiraDetailed,
} from "../story-sync-media";

vi.mock("@repo/utils/url-security", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils/url-security")>()),
	safeFetchOutboundPinned: vi.fn(),
}));

const fetchPinned = vi.mocked(safeFetchOutboundPinned);
const imageUrl = "https://example.com/image.png";
const imageBytes = new Uint8Array([137, 80, 78, 71]);

beforeEach(() => {
	fetchPinned.mockReset();
	vi.spyOn(logger, "warn").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(imageBytes, {
					headers: { "content-type": "image/png" },
				}),
		),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

// Use the same Undici installation as the shared downloader.
const require = createRequire(import.meta.resolve("@repo/utils/url-security"));
const { MockAgent } = require("undici");

async function mockCheckedTransport() {
	const agent = new MockAgent();
	agent.disableNetConnect();
	const guard = await vi.importActual<
		typeof import("@repo/utils/url-security")
	>("@repo/utils/url-security");
	fetchPinned.mockImplementation((url, init, options) =>
		guard.safeFetchOutboundPinned(url, init, {
			...options,
			dispatcher: agent,
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		}),
	);
	return agent;
}

const fileBody = "example document";
const fileHeaders = { "content-type": "application/pdf" };
const fizzyTarget = { accountSlug: "example-org", apiKey: "example-token" };

function mockFizzyUpload() {
	const metadata = vi.fn(async (_init: RequestInit) =>
		Response.json({
			attachable_sgid: "example-attachment",
			direct_upload: { url: "https://storage.example.com/upload" },
		}),
	);
	const upload = vi.fn(
		async (_init: RequestInit) => new Response(null, { status: 204 }),
	);
	vi.mocked(fetch).mockImplementation(async (url, init) => {
		if (
			init?.method === "POST" &&
			String(url).endsWith("/direct_uploads")
		) {
			return metadata(init);
		}
		if (
			init?.method === "PUT" &&
			url === "https://storage.example.com/upload"
		) {
			return upload(init);
		}
		throw new Error("Unexpected upload request");
	});
	return { metadata, upload };
}

describe("story file downloads", () => {
	const path = "/story-media/example.pdf";
	const src = `https://storage.example.com${path}`;

	it("uploads a PDF file link to GitLab and skips the same response as an image", async () => {
		const agent = await mockCheckedTransport();
		const upload = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ url: "/uploads/example.pdf" }),
		);
		vi.stubGlobal("fetch", upload);
		try {
			agent
				.get("https://storage.example.com")
				.intercept({ path })
				.reply(200, fileBody, { headers: fileHeaders })
				.times(2);

			expect(
				await uploadGitLabFileAttachmentsAndRewrite(
					`[Document](${src})`,
					{
						token: "example-token",
						projectId: "example-org/example-project",
					},
				),
			).toBe("[Document](/uploads/example.pdf)");
			expect(await fetchImageAsBase64DataUrl(src)).toBeNull();
			expect(upload).toHaveBeenCalledOnce();
			const file = (upload.mock.calls[0]?.[1]?.body as FormData).get(
				"file",
			) as File;
			expect(file.type).toBe("application/pdf");
			expect(await file.text()).toBe(fileBody);
			expect(fetchPinned.mock.calls[0]?.[2]?.maxBytes).toBe(
				25 * 1024 * 1024,
			);
			agent.assertNoPendingInterceptors();
		} finally {
			await agent.close();
		}
	});

	it("uploads a PDF file anchor to Fizzy through the checked downloader", async () => {
		const agent = await mockCheckedTransport();
		const { metadata, upload } = mockFizzyUpload();
		try {
			agent
				.get("https://storage.example.com")
				.intercept({ path })
				.reply(200, fileBody, { headers: fileHeaders });

			expect(
				await resolveFizzyFileEmbeds(
					[
						{
							href: src,
							filename: "example.pdf",
							s3Key: "story-media/example.pdf",
						},
					],
					fizzyTarget,
				),
			).toEqual([
				'<action-text-attachment sgid="example-attachment"></action-text-attachment>',
			]);
			expect(metadata).toHaveBeenCalledOnce();
			expect(upload).toHaveBeenCalledWith(
				expect.objectContaining({ body: Buffer.from(fileBody) }),
			);
			expect(fetchPinned.mock.calls[0]?.[2]?.maxBytes).toBe(
				25 * 1024 * 1024,
			);
			agent.assertNoPendingInterceptors();
		} finally {
			await agent.close();
		}
	});
});

const jiraSite = { cloudId: "example-cloud", siteUrl: "https://example.com" };
const jiraTarget = {
	...jiraSite,
	accessToken: "example-token",
	mcpConfigId: "example-config",
	resources: [jiraSite],
};
const gitlabTarget = {
	token: "example-token",
	projectId: "example-org/example-project",
};

it("skips relative sources without requests, warnings or Jira errors", async () => {
	vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com");
	const src = "/api/storage/image?path=/story-media/example.png";
	const image = { src, alt: "Example", s3Key: null };
	const markdown = `![Example](${src})`;
	const fileLink = `[Example](${src})`;
	fetchPinned.mockRejectedValue(new Error("Unexpected download"));

	expect(
		await uploadAdoImageAttachments([image], {
			org: "example-org",
			pat: "example-token",
		}),
	).toEqual([image]);
	expect(
		await uploadGitLabImagesAndRewriteDescription(markdown, gitlabTarget),
	).toBe(markdown);
	expect(
		await uploadGitLabFileAttachmentsAndRewrite(fileLink, gitlabTarget),
	).toBe(fileLink);
	expect(await fetchImageAsBase64DataUrl(src)).toBeNull();
	expect(await inlineJiraMarkdownImagesAsBase64DataUrls(markdown)).toBe(
		markdown,
	);
	expect(await uploadFizzyImageAttachments([image], fizzyTarget)).toEqual([
		{ kind: "fallback", ref: image },
	]);
	expect(
		await resolveFizzyFileEmbeds(
			[
				{
					href: src,
					filename: "example.png",
					s3Key: "story-media/example.png",
				},
			],
			fizzyTarget,
		),
	).toEqual([`<a href="${src}">example.png</a>`]);
	expect(
		await uploadJiraImagesAndRewriteDescription(
			markdown,
			jiraTarget,
			jiraSite,
			"EXAMPLE-1",
		),
	).toMatchObject({
		description: markdown,
		uploaded: 0,
		failed: 0,
		errors: [],
	});
	expect(
		await uploadOneImageToJiraDetailed(
			jiraTarget,
			jiraSite,
			"EXAMPLE-1",
			src,
			"example.png",
		),
	).toEqual({ attachment: null, error: null });
	expect(fetchPinned).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
	expect(logger.warn).not.toHaveBeenCalled();
});

it.each([
	[new UnsafeOutboundUrlError("Address refused"), "UNSAFE_OUTBOUND_URL"],
	[
		new OutboundResponseRejectedError(
			"CONTENT_TYPE_NOT_ALLOWED",
			"Unexpected content type",
		),
		"CONTENT_TYPE_NOT_ALLOWED",
	],
	[
		new OutboundResponseRejectedError(
			"RESPONSE_TOO_LARGE",
			"Response exceeds limit",
		),
		"RESPONSE_TOO_LARGE",
	],
	[new Error("Transport unavailable"), "source request failed"],
	[
		new UnsafeOutboundUrlError("Resolution failed", {
			cause: new Error("DNS unavailable"),
		}),
		"source request failed",
	],
])(
	"puts the safe download reason in Jira logs and errors (%s)",
	async (error, reason) => {
		const src =
			"https://storage.example.com/story-media/example.png?signature=example";
		fetchPinned.mockRejectedValue(error);

		const result = await uploadJiraImagesAndRewriteDescription(
			`![Example](${src})`,
			jiraTarget,
			jiraSite,
			"EXAMPLE-1",
		);
		expect(result.errors).toEqual([`image fetch threw (${reason})`]);
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			"[Jira Cloud] image fetch threw",
			{
				issueKey: "EXAMPLE-1",
				sourceHost: "storage.example.com",
				error: reason,
			},
		);
		expect(fetch).not.toHaveBeenCalled();
	},
);

it.each(["image", "file"] as const)(
	"labels a refused GitLab %s source as a download failure",
	async (kind) => {
		const src =
			"https://storage.example.com/story-media/example.png?signature=example";
		fetchPinned.mockRejectedValue(
			new UnsafeOutboundUrlError("Address refused"),
		);
		const upload =
			kind === "image"
				? uploadGitLabImagesAndRewriteDescription
				: uploadGitLabFileAttachmentsAndRewrite;
		const description = `${kind === "image" ? "!" : ""}[Example](${src})`;

		expect(await upload(description, gitlabTarget)).toBe(description);
		expect(fetch).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			"[GitLab Attachments] Source fetch threw",
			{
				sourceHost: "storage.example.com",
				error: "UNSAFE_OUTBOUND_URL",
			},
		);
	},
);

it.each(["image", "file"] as const)(
	"keeps the GitLab %s upload error message",
	async (kind) => {
		const src =
			"https://storage.example.com/story-media/example.png?signature=example";
		fetchPinned.mockResolvedValue(
			new Response(imageBytes, {
				headers: { "content-type": "image/png" },
			}),
		);
		vi.mocked(fetch).mockRejectedValue(
			new Error("Provider connection closed"),
		);
		const upload =
			kind === "image"
				? uploadGitLabImagesAndRewriteDescription
				: uploadGitLabFileAttachmentsAndRewrite;
		const description = `${kind === "image" ? "!" : ""}[Example](${src})`;

		expect(await upload(description, gitlabTarget)).toBe(description);
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			kind === "image"
				? "[GitLab Attachments] upload threw"
				: "[GitLab Attachments] file upload threw",
			{ error: "Provider connection closed" },
		);
	},
);

it.each(["POST", "PUT"] as const)(
	"keeps the Fizzy %s failure body and transport message",
	async (method) => {
		const src =
			"https://storage.example.com/story-media/example.png?signature=example";
		const image = { src, alt: "example.png", s3Key: null };
		const body = "Provider could not store the attachment. ".repeat(10);
		fetchPinned.mockImplementation(
			async () =>
				new Response(imageBytes, {
					headers: { "content-type": "image/png" },
				}),
		);
		vi.mocked(fetch).mockImplementation(async (_url, init) => {
			if (init?.method === method) {
				return new Response(body, { status: 503 });
			}
			return Response.json({
				attachable_sgid: "example",
				direct_upload: { url: "https://storage.example.com/upload" },
			});
		});

		await uploadFizzyImageAttachments([image], fizzyTarget);
		const operation =
			method === "POST" ? "direct_uploads POST" : "PUT to signed URL";
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			`[Fizzy Attachments] ${operation} failed`,
			{
				sourceHost: "storage.example.com",
				fileName: "example.png",
				status: 503,
				body: body.slice(0, 200),
			},
		);

		vi.mocked(logger.warn).mockClear();
		vi.mocked(fetch).mockImplementation(async (_url, init) => {
			if (init?.method === method) {
				throw new Error("Provider connection closed");
			}
			return Response.json({
				attachable_sgid: "example",
				direct_upload: { url: "https://storage.example.com/upload" },
			});
		});
		await uploadFizzyImageAttachments([image], fizzyTarget);
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
			`[Fizzy Attachments] ${operation} threw`,
			{
				sourceHost: "storage.example.com",
				error: "Provider connection closed",
			},
		);
	},
);

it("summarizes incomplete Fizzy metadata without including signed values", async () => {
	const image = {
		src: "https://storage.example.com/story-media/example.png?signature=example",
		alt: "example.png",
		s3Key: null,
	};
	fetchPinned.mockResolvedValue(
		new Response(imageBytes, { headers: { "content-type": "image/png" } }),
	);
	vi.mocked(fetch).mockResolvedValue(
		Response.json({
			direct_upload: {
				url: "https://storage.example.com/upload?signature=example",
			},
		}),
	);

	expect(await uploadFizzyImageAttachments([image], fizzyTarget)).toEqual([
		{ kind: "fallback", ref: image },
	]);
	expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
		"[Fizzy Attachments] direct_uploads response missing signed_id or url",
		{
			sourceHost: "storage.example.com",
			responsePreview: JSON.stringify({
				hasSignedId: false,
				hasUploadUrl: true,
			}),
		},
	);
});

describe("story image downloads", () => {
	it("uses the checked response for a normal image", async () => {
		fetchPinned.mockResolvedValue(
			new Response(imageBytes, {
				headers: { "content-type": "image/png" },
			}),
		);

		expect(await fetchImageAsBase64DataUrl(imageUrl)).toBe(
			"data:image/png;base64,iVBORw==",
		);
		expect(fetchPinned).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("skips a refused source", async () => {
		fetchPinned.mockRejectedValue(new Error("Source address refused"));

		expect(await fetchImageAsBase64DataUrl(imageUrl)).toBeNull();
	});

	it("refuses a loopback image before reaching the server", async () => {
		const received = vi.fn();
		const server = createServer((_request, response) => {
			received();
			response.setHeader("Content-Type", "image/png");
			response.end(imageBytes);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/image.png`;
		const agent = await mockCheckedTransport();
		try {
			expect(await fetchImageAsBase64DataUrl(url)).toBeNull();
			expect(received).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await agent.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("checks a redirected destination before sending another request", async () => {
		const agent = await mockCheckedTransport();
		try {
			agent
				.get("https://example.com")
				.intercept({ path: "/image.png" })
				.reply(302, "", {
					headers: { location: "http://127.0.0.1/image.png" },
				});
			const redirected = vi.fn(() => Buffer.from(imageBytes));
			agent
				.get("http://127.0.0.1")
				.intercept({ path: "/image.png" })
				.reply(200, redirected, {
					headers: { "content-type": "image/png" },
				});
			expect(await fetchImageAsBase64DataUrl(imageUrl)).toBeNull();
			expect(redirected).not.toHaveBeenCalled();
			expect(agent.pendingInterceptors()).toHaveLength(1);
		} finally {
			await agent.close();
		}
	});

	it("follows a redirect to another public image origin", async () => {
		const agent = await mockCheckedTransport();
		try {
			agent
				.get("https://example.com")
				.intercept({ path: "/image.png" })
				.reply(302, "", {
					headers: {
						location: "https://storage.example.com/image.png",
					},
				});
			const download = vi.fn(() => Buffer.from(imageBytes));
			agent
				.get("https://storage.example.com")
				.intercept({ path: "/image.png" })
				.reply(200, download, {
					headers: { "content-type": "image/png" },
				});
			expect(await fetchImageAsBase64DataUrl(imageUrl)).toBe(
				"data:image/png;base64,iVBORw==",
			);
			expect(download).toHaveBeenCalledOnce();
			agent.assertNoPendingInterceptors();
		} finally {
			await agent.close();
		}
	});

	it.each(["text/plain", null])(
		"requires an image Content-Type (%s)",
		async (contentType) => {
			const agent = await mockCheckedTransport();
			try {
				agent
					.get("https://example.com")
					.intercept({ path: "/image.png" })
					.reply(200, Buffer.from(imageBytes), {
						headers: contentType
							? { "content-type": contentType }
							: {},
					});
				expect(await fetchImageAsBase64DataUrl(imageUrl)).toBeNull();
				expect(
					fetchPinned.mock.calls[0]?.[2]?.allowedContentTypes,
				).toEqual([
					"image/png",
					"image/jpeg",
					"image/gif",
					"image/webp",
					"image/svg+xml",
				]);
				agent.assertNoPendingInterceptors();
			} finally {
				await agent.close();
			}
		},
	);

	it("skips a body over the inline byte limit without a Content-Length", async () => {
		const agent = await mockCheckedTransport();
		try {
			agent
				.get("https://example.com")
				.intercept({ path: "/image.png" })
				.reply(200, Buffer.alloc(2 * 1024 * 1024 + 1), {
					headers: { "content-type": "image/png" },
				});
			expect(await fetchImageAsBase64DataUrl(imageUrl)).toBeNull();
			agent.assertNoPendingInterceptors();
		} finally {
			await agent.close();
		}
	});

	describe("development storage", () => {
		const endpoint = "http://127.0.0.1:9000";
		const source = `${endpoint}/${config.storage.bucketNames.projectContexts}/story-media/example.png?signature=example`;

		beforeEach(() => {
			vi.stubEnv("NODE_ENV", "development");
			vi.stubEnv("S3_ENDPOINT", endpoint);
			vi.stubEnv("STORY_SYNC_MEDIA_ALLOWED_HOSTS", undefined);
		});

		it("reads configured storage with redirects disabled", async () => {
			expect(await fetchImageAsBase64DataUrl(source)).toBe(
				"data:image/png;base64,iVBORw==",
			);
			expect(fetch).toHaveBeenCalledWith(
				source,
				expect.objectContaining({ redirect: "error" }),
			);
			expect(fetchPinned).not.toHaveBeenCalled();
		});

		it.each(["text/plain", null])(
			"checks the storage response type (%s)",
			async (type) => {
				vi.mocked(fetch).mockResolvedValue(
					new Response(imageBytes, {
						headers: type ? { "content-type": type } : {},
					}),
				);
				expect(await fetchImageAsBase64DataUrl(source)).toBeNull();
			},
		);

		it.each(["application/pdf", "application/octet-stream", null])(
			"uploads a storage file response (%s) and skips it as an image",
			async (type) => {
				const { metadata, upload } = mockFizzyUpload();
				const uploadFetch = vi.mocked(fetch).getMockImplementation();
				vi.mocked(fetch).mockImplementation(async (url, init) => {
					if (url === source) {
						return new Response(
							new TextEncoder().encode(fileBody),
							{
								headers: type
									? { "content-type": type }
									: new Headers(),
							},
						);
					}
					if (!uploadFetch) {
						throw new Error("Missing upload handler");
					}
					return uploadFetch(url, init);
				});

				expect(
					await resolveFizzyFileEmbeds(
						[
							{
								href: source,
								filename: "example.pdf",
								s3Key: "story-media/example.pdf",
							},
						],
						fizzyTarget,
					),
				).toEqual([
					'<action-text-attachment sgid="example-attachment"></action-text-attachment>',
				]);
				expect(await fetchImageAsBase64DataUrl(source)).toBeNull();
				expect(fetchPinned).not.toHaveBeenCalled();
				expect(metadata).toHaveBeenCalledOnce();
				expect(
					JSON.parse(String(metadata.mock.calls[0]?.[0].body)).blob
						.content_type,
				).toBe("application/pdf");
				expect(upload).toHaveBeenCalledWith(
					expect.objectContaining({ body: Buffer.from(fileBody) }),
				);
			},
		);

		it("caps the storage response while reading it", async () => {
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(2 * 1024 * 1024));
					controller.enqueue(new Uint8Array(1));
					controller.enqueue(new Uint8Array(1));
					controller.close();
				},
				cancel,
			});
			vi.mocked(fetch).mockResolvedValue(
				new Response(body, {
					headers: { "content-type": "image/png" },
				}),
			);
			expect(await fetchImageAsBase64DataUrl(source)).toBeNull();
			expect(cancel).toHaveBeenCalledOnce();
		});

		it.each([
			source.replace(":9000", ":9001"),
			`${endpoint}/example.png`,
			source.replace("http://", "http://example@"),
			source.replace("http://", "http://:example@"),
		])(
			"uses the public address checks for URLs outside the storage rule (%s)",
			async (url) => {
				fetchPinned.mockRejectedValue(
					new Error("Source address refused"),
				);
				expect(await fetchImageAsBase64DataUrl(url)).toBeNull();
				expect(fetchPinned).toHaveBeenCalledOnce();
				expect(fetch).not.toHaveBeenCalled();
			},
		);

		it("uses the public address checks in production", async () => {
			vi.stubEnv("NODE_ENV", "production");
			vi.stubEnv("STORY_SYNC_MEDIA_ALLOWED_HOSTS", "127.0.0.1");
			fetchPinned.mockRejectedValue(new Error("Source address refused"));
			expect(await fetchImageAsBase64DataUrl(source)).toBeNull();
			expect(fetchPinned).toHaveBeenCalledOnce();
			expect(fetch).not.toHaveBeenCalled();
		});

		it("allows the operator to disable the development storage exception", async () => {
			vi.stubEnv("STORY_SYNC_MEDIA_ALLOWED_HOSTS", "");
			fetchPinned.mockRejectedValue(new Error("Source address refused"));
			expect(await fetchImageAsBase64DataUrl(source)).toBeNull();
			expect(fetchPinned).toHaveBeenCalledOnce();
			expect(fetch).not.toHaveBeenCalled();
		});
	});
});

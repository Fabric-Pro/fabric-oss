/**
 * `sends.images.*` — review images of a held release-notes send. Fully
 * offline: `@repo/database` and the storage provider are mocked, the key
 * builders in `lib/review-images.ts` and `buildTenantStoragePath` are real, and
 * each procedure's `.handler` is invoked directly via the chainable-proxy
 * `_handler` (same harness as sends-approve.test.ts).
 *
 * The row-locked checks themselves (PENDING_APPROVAL, screenshotsEnabled,
 * highlight range, two per highlight, project scoping) live in the query layer
 * and run against real Postgres in
 * `packages/database/prisma/queries/projects/__tests__/newsletter-images.test.ts`.
 * Here: the procedures refuse early, map every refusal to the right error,
 * never trust a client-named key, enforce the upload limits server-side, and
 * clean up the objects they leave behind.
 *
 * Run with: pnpm --filter @repo/api test sends-images
 */

import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	getNewsletterSendForSendPhase: vi.fn(),
	getNewsletterSendImage: vi.fn(),
	createNewsletterSendImage: vi.fn(),
	updateNewsletterSendImage: vi.fn(),
	replaceNewsletterSendImageStorage: vi.fn(),
	deleteNewsletterSendImage: vi.fn(),
	workflowCancel: vi.fn(),
	getHandle: vi.fn(),
	storage: {
		supportsPresignedUrls: true,
		getSignedUploadUrl: vi.fn(),
		getSignedUrl: vi.fn(),
		getFileMetadata: vi.fn(),
		copyFile: vi.fn(),
		downloadFile: vi.fn(),
		deleteObjects: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
	getNewsletterSendForSendPhase: mocks.getNewsletterSendForSendPhase,
	getNewsletterSendImage: mocks.getNewsletterSendImage,
	createNewsletterSendImage: mocks.createNewsletterSendImage,
	updateNewsletterSendImage: mocks.updateNewsletterSendImage,
	replaceNewsletterSendImageStorage: mocks.replaceNewsletterSendImageStorage,
	deleteNewsletterSendImage: mocks.deleteNewsletterSendImage,
	listNewsletterSendImages: vi.fn(),
	newsletterImagePlacementSchema: z.enum(["BELOW", "ABOVE"]),
	NEWSLETTER_IMAGE_ALT_TEXT_MAX: 300,
}));

vi.mock("@repo/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/storage")>()),
	getStorageProvider: () => mocks.storage,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	PROPOSAL_EXPORT_TASK_QUEUE: "proposal-export",
	isTemporalAvailable: vi.fn(),
	getTemporalClient: async () => ({
		workflow: { getHandle: mocks.getHandle },
	}),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { NEWSLETTER_IMAGE_MAX_BYTES } from "../../lib/review-images";
import { addImageProcedure } from "../sends-images-add";
import { createImageUploadUrlProcedure } from "../sends-images-create-upload-url";
import { removeImageProcedure } from "../sends-images-remove";
import { replaceImageProcedure } from "../sends-images-replace";
import { updateImageProcedure } from "../sends-images-update";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const handlerOf = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;
const createUploadUrl = handlerOf(createImageUploadUrlProcedure);
const add = handlerOf(addImageProcedure);
const replace = handlerOf(replaceImageProcedure);
const update = handlerOf(updateImageProcedure);
const remove = handlerOf(removeImageProcedure);

const context = {
	user: { id: "reviewer-1", email: "r@example.com", name: "Reviewer" },
};

const BUCKET = config.storage.bucketNames.projectContexts;
const TOKEN = "A".repeat(32);
const PENDING_KEY = `org-9/newsletter-images/send-1/pending/${TOKEN}`;

/** A file of `size` bytes that starts like a real PNG. */
const pngBytes = (size: number) =>
	Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.alloc(size - 8),
	]);

const downloaded = (data: Buffer, contentType = "image/png") => ({
	data,
	contentType,
	size: data.length,
});

const reviewableSend = (overrides: Record<string, unknown> = {}) => ({
	id: "send-1",
	projectId: "p1",
	status: "PENDING_APPROVAL",
	screenshotsEnabled: true,
	...overrides,
});

const imageRow = (overrides: Record<string, unknown> = {}) => ({
	id: "img-1",
	sendId: "send-1",
	highlightIndex: 0,
	position: 0,
	captureState: "READY",
	included: true,
	source: "UPLOAD",
	storageKey: "org-9/newsletter-images/send-1/kept.png",
	altText: "",
	width: null,
	height: null,
	bytes: 1000,
	errorMessage: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	...overrides,
});

async function errorOf(promise: Promise<unknown>) {
	const error = await promise.catch((e: unknown) => e);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<
		string,
		{ code?: string; currentStatus?: string }
	>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-9",
		userId: "owner-1",
	});
	mocks.getNewsletterSendForSendPhase.mockResolvedValue(reviewableSend());
	mocks.storage.getSignedUploadUrl.mockResolvedValue(
		"https://storage.example.com/put",
	);
	mocks.storage.getSignedUrl.mockResolvedValue(
		"https://storage.example.com/get",
	);
	mocks.storage.getFileMetadata.mockResolvedValue({
		size: 120_000,
		contentType: "image/png",
	});
	mocks.storage.copyFile.mockResolvedValue(undefined);
	mocks.storage.downloadFile.mockResolvedValue(downloaded(pngBytes(120_000)));
	mocks.storage.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
	mocks.createNewsletterSendImage.mockImplementation(async (input) => ({
		ok: true,
		image: imageRow({
			highlightIndex: input.highlightIndex,
			storageKey: input.storageKey,
		}),
	}));
});

const addInput = (overrides: Record<string, unknown> = {}) => ({
	projectId: "p1",
	organizationId: "org-9",
	sendId: "send-1",
	highlightIndex: 0,
	uploadToken: TOKEN,
	...overrides,
});

describe("sends.images.createUploadUrl", () => {
	it("signs a PUT for a server-built key under the project's tenant and the send", async () => {
		const result = await createUploadUrl({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				contentType: "image/png",
				contentLength: 1000,
			},
			context,
		});

		const { uploadToken } = result as { uploadToken: string };
		expect(uploadToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(mocks.storage.getSignedUploadUrl).toHaveBeenCalledWith(
			`org-9/newsletter-images/send-1/pending/${uploadToken}`,
			expect.objectContaining({
				bucket: BUCKET,
				contentType: "image/png",
				contentLength: 1000,
			}),
		);
		expect(result).toEqual({
			signedUploadUrl: "https://storage.example.com/put",
			uploadToken,
		});
	});

	it("uses the owner's id as the tenant prefix of a personal project", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
			userId: "owner-1",
		});

		const result = (await createUploadUrl({
			input: {
				projectId: "p1",
				sendId: "send-1",
				contentType: "image/jpeg",
			},
			context,
		})) as { uploadToken: string };

		expect(mocks.storage.getSignedUploadUrl).toHaveBeenCalledWith(
			`owner-1/newsletter-images/send-1/pending/${result.uploadToken}`,
			expect.anything(),
		);
	});

	it("refuses a declared size over the limit before signing", async () => {
		const error = await errorOf(
			createUploadUrl({
				input: {
					projectId: "p1",
					sendId: "send-1",
					contentType: "image/png",
					contentLength: NEWSLETTER_IMAGE_MAX_BYTES + 1,
				},
				context,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("too_large");
		expect(mocks.storage.getSignedUploadUrl).not.toHaveBeenCalled();
	});

	it("answers CONFLICT for a send that is no longer awaiting review", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			reviewableSend({ status: "APPROVED" }),
		);

		const error = await errorOf(
			createUploadUrl({
				input: {
					projectId: "p1",
					sendId: "send-1",
					contentType: "image/png",
				},
				context,
			}),
		);

		expect(error.code).toBe("CONFLICT");
		expect(error.data?.currentStatus).toBe("APPROVED");
		expect(mocks.storage.getSignedUploadUrl).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for another project's send", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			reviewableSend({ projectId: "other-project" }),
		);

		const error = await errorOf(
			createUploadUrl({
				input: {
					projectId: "p1",
					sendId: "send-1",
					contentType: "image/png",
				},
				context,
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
	});
});

describe("sends.images.add", () => {
	it("checks the upload, copies it to a key the PUT cannot reach, and creates the image", async () => {
		const result = (await add({
			input: addInput({
				altText: "The new panel",
				width: 800,
				height: 450,
			}),
			context,
		})) as { image: Record<string, unknown> };

		const [source, destination] = mocks.storage.copyFile.mock.calls[0];
		expect(source).toBe(PENDING_KEY);
		expect(destination).toMatch(
			/^org-9\/newsletter-images\/send-1\/[0-9a-f-]{36}\.png$/,
		);
		// The bytes are checked on the copy the signed PUT cannot overwrite.
		expect(mocks.storage.downloadFile).toHaveBeenCalledWith(destination, {
			bucket: BUCKET,
		});
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[PENDING_KEY],
			{
				bucket: BUCKET,
			},
		);
		expect(mocks.createNewsletterSendImage).toHaveBeenCalledWith({
			projectId: "p1",
			sendId: "send-1",
			highlightIndex: 0,
			storageKey: destination,
			bytes: 120_000,
			width: 800,
			height: 450,
			altText: "The new panel",
			createdByUserId: "reviewer-1",
		});
		expect(result.image.url).toBe("https://storage.example.com/get");
		expect(result.image.downloadUrl).toBe(
			"https://storage.example.com/get",
		);
		expect(result.image).not.toHaveProperty("storageKey");
		expect(mocks.storage.getSignedUrl).toHaveBeenCalledWith(
			destination,
			expect.objectContaining({ responseContentDisposition: "inline" }),
		);
		expect(mocks.storage.getSignedUrl).toHaveBeenCalledWith(
			destination,
			expect.objectContaining({
				responseContentDisposition:
					'attachment; filename="newsletter-image.png"',
			}),
		);
	});

	it("answers CONFLICT when the send is no longer awaiting review, and touches no storage", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			reviewableSend({ status: "SENT" }),
		);

		const error = await errorOf(add({ input: addInput(), context }));

		expect(error.code).toBe("CONFLICT");
		expect(mocks.storage.getFileMetadata).not.toHaveBeenCalled();
		expect(mocks.createNewsletterSendImage).not.toHaveBeenCalled();
	});

	it("answers BAD_REQUEST when images are off for the send", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			reviewableSend({ screenshotsEnabled: false }),
		);

		const error = await errorOf(add({ input: addInput(), context }));

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.storage.getFileMetadata).not.toHaveBeenCalled();
	});

	it("refuses an image over the size limit and deletes the upload", async () => {
		mocks.storage.getFileMetadata.mockResolvedValue({
			size: NEWSLETTER_IMAGE_MAX_BYTES + 1,
			contentType: "image/png",
		});

		const error = await errorOf(add({ input: addInput(), context }));

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("too_large");
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[PENDING_KEY],
			{
				bucket: BUCKET,
			},
		);
		expect(mocks.storage.copyFile).not.toHaveBeenCalled();
		expect(mocks.createNewsletterSendImage).not.toHaveBeenCalled();
	});

	it("refuses a stored type that is not PNG or JPEG and deletes the upload", async () => {
		mocks.storage.getFileMetadata.mockResolvedValue({
			size: 1000,
			contentType: "image/svg+xml",
		});

		const error = await errorOf(add({ input: addInput(), context }));

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("unsupported");
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[PENDING_KEY],
			{
				bucket: BUCKET,
			},
		);
		expect(mocks.createNewsletterSendImage).not.toHaveBeenCalled();
	});

	it.each([
		["an HTML page", "<!doctype html><script>alert(1)</script>"],
		["an SVG image", '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
		["a JPEG", "\xff\xd8\xff\xe0 not a png"],
	])(
		"refuses %s labelled image/png and deletes the upload and its copy",
		async (_label, body) => {
			mocks.storage.downloadFile.mockResolvedValue(
				downloaded(Buffer.from(body, "latin1")),
			);

			const error = await errorOf(add({ input: addInput(), context }));

			expect(error.code).toBe("BAD_REQUEST");
			expect(error.data?.code).toBe("unsupported");
			const destination = mocks.storage.copyFile.mock.calls[0][1];
			expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
				[PENDING_KEY, destination],
				{ bucket: BUCKET },
			);
			expect(mocks.createNewsletterSendImage).not.toHaveBeenCalled();
		},
	);

	it("refuses an upload swapped for a larger file after the size check", async () => {
		mocks.storage.downloadFile.mockResolvedValue(
			downloaded(pngBytes(NEWSLETTER_IMAGE_MAX_BYTES + 1)),
		);

		const error = await errorOf(add({ input: addInput(), context }));

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("too_large");
		const destination = mocks.storage.copyFile.mock.calls[0][1];
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[PENDING_KEY, destination],
			{ bucket: BUCKET },
		);
		expect(mocks.createNewsletterSendImage).not.toHaveBeenCalled();
	});

	it("answers INTERNAL_SERVER_ERROR and deletes the copy when its bytes cannot be read", async () => {
		mocks.storage.downloadFile.mockRejectedValue(new Error("storage down"));

		const error = await errorOf(add({ input: addInput(), context }));

		expect(error.code).toBe("INTERNAL_SERVER_ERROR");
		const destination = mocks.storage.copyFile.mock.calls[0][1];
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[destination],
			{ bucket: BUCKET },
		);
		expect(mocks.createNewsletterSendImage).not.toHaveBeenCalled();
	});

	it("refuses a token that is not a token, before reaching storage", async () => {
		const error = await errorOf(
			add({
				input: addInput({ uploadToken: "../../other-org/secret.png" }),
				context,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.storage.getFileMetadata).not.toHaveBeenCalled();
	});

	it("refuses a token whose upload is not under this send", async () => {
		mocks.storage.getFileMetadata.mockResolvedValue(null);

		const error = await errorOf(add({ input: addInput(), context }));

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.storage.getFileMetadata).toHaveBeenCalledWith(
			PENDING_KEY,
			{
				bucket: BUCKET,
			},
		);
		expect(mocks.createNewsletterSendImage).not.toHaveBeenCalled();
	});

	it.each([
		[
			"an index outside the highlights",
			"HIGHLIGHT_OUT_OF_RANGE",
			"BAD_REQUEST",
		],
		["a third image on a highlight", "HIGHLIGHT_FULL", "BAD_REQUEST"],
		[
			"a send that stopped awaiting review meanwhile",
			"NOT_PENDING",
			"CONFLICT",
		],
	])(
		"answers %s and deletes the committed object",
		async (_label, reason, code) => {
			mocks.createNewsletterSendImage.mockResolvedValue({
				ok: false,
				refusal: { reason, status: "APPROVED" },
			});

			const error = await errorOf(add({ input: addInput(), context }));

			expect(error.code).toBe(code);
			const destination = mocks.storage.copyFile.mock.calls[0][1];
			expect(mocks.storage.deleteObjects).toHaveBeenLastCalledWith(
				[destination],
				{ bucket: BUCKET },
			);
		},
	);

	it("refuses an organization that is not the project's before anything else", async () => {
		const error = await errorOf(
			add({ input: addInput({ organizationId: "org-other" }), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.getNewsletterSendForSendPhase).not.toHaveBeenCalled();
	});
});

describe("sends.images.update", () => {
	it("scopes the write to the loaded project and returns the image without its key", async () => {
		mocks.updateNewsletterSendImage.mockResolvedValue({
			ok: true,
			image: imageRow({ included: false, altText: "Settings page" }),
		});

		const result = (await update({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				imageId: "img-1",
				included: false,
				altText: "Settings page",
			},
			context,
		})) as { image: Record<string, unknown> };

		expect(mocks.updateNewsletterSendImage).toHaveBeenCalledWith({
			projectId: "p1",
			imageId: "img-1",
			included: false,
			altText: "Settings page",
			highlightIndex: undefined,
			position: undefined,
		});
		expect(result.image).toMatchObject({
			included: false,
			altText: "Settings page",
		});
		expect(result.image).not.toHaveProperty("storageKey");
	});

	it("refuses a move onto a full highlight", async () => {
		mocks.updateNewsletterSendImage.mockResolvedValue({
			ok: false,
			refusal: { reason: "HIGHLIGHT_FULL" },
		});

		const error = await errorOf(
			update({
				input: { projectId: "p1", imageId: "img-1", highlightIndex: 2 },
				context,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("highlight_full");
	});

	it("answers NOT_FOUND for an image of another project", async () => {
		mocks.updateNewsletterSendImage.mockResolvedValue({
			ok: false,
			refusal: { reason: "IMAGE_NOT_FOUND" },
		});

		const error = await errorOf(
			update({
				input: {
					projectId: "p1",
					imageId: "img-elsewhere",
					included: true,
				},
				context,
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
	});

	it("answers CONFLICT once the send is no longer awaiting review", async () => {
		mocks.updateNewsletterSendImage.mockResolvedValue({
			ok: false,
			refusal: { reason: "NOT_PENDING", status: "REJECTED" },
		});

		const error = await errorOf(
			update({
				input: { projectId: "p1", imageId: "img-1", included: true },
				context,
			}),
		);

		expect(error.code).toBe("CONFLICT");
		expect(error.data?.currentStatus).toBe("REJECTED");
	});

	it("answers BAD_REQUEST when images are off for the send", async () => {
		mocks.updateNewsletterSendImage.mockResolvedValue({
			ok: false,
			refusal: { reason: "SCREENSHOTS_DISABLED" },
		});

		const error = await errorOf(
			update({
				input: { projectId: "p1", imageId: "img-1", included: true },
				context,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
	});

	it("refuses an organization that is not the project's", async () => {
		const error = await errorOf(
			update({
				input: {
					projectId: "p1",
					organizationId: "org-other",
					imageId: "img-1",
					included: true,
				},
				context,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.updateNewsletterSendImage).not.toHaveBeenCalled();
	});
});

describe("sends.images.replace", () => {
	it("commits the new upload against the image's own send and deletes the old object", async () => {
		mocks.getNewsletterSendImage.mockResolvedValue(imageRow());
		mocks.replaceNewsletterSendImageStorage.mockImplementation(
			async (input) => ({
				ok: true,
				image: imageRow({ storageKey: input.storageKey }),
				previousStorageKey: "org-9/newsletter-images/send-1/kept.png",
			}),
		);

		await replace({
			input: { projectId: "p1", imageId: "img-1", uploadToken: TOKEN },
			context,
		});

		expect(mocks.getNewsletterSendImage).toHaveBeenCalledWith(
			"p1",
			"img-1",
		);
		expect(mocks.storage.copyFile.mock.calls[0][0]).toBe(PENDING_KEY);
		expect(mocks.storage.deleteObjects).toHaveBeenLastCalledWith(
			["org-9/newsletter-images/send-1/kept.png"],
			{ bucket: BUCKET },
		);
	});

	it("refuses a PNG-labelled upload that is not a PNG and keeps the old object", async () => {
		mocks.getNewsletterSendImage.mockResolvedValue(imageRow());
		mocks.storage.downloadFile.mockResolvedValue(
			downloaded(Buffer.from("<html><body>not an image</body></html>")),
		);

		const error = await errorOf(
			replace({
				input: {
					projectId: "p1",
					imageId: "img-1",
					uploadToken: TOKEN,
				},
				context,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("unsupported");
		const destination = mocks.storage.copyFile.mock.calls[0][1];
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[PENDING_KEY, destination],
			{ bucket: BUCKET },
		);
		expect(mocks.storage.deleteObjects).not.toHaveBeenCalledWith(
			["org-9/newsletter-images/send-1/kept.png"],
			expect.anything(),
		);
		expect(mocks.replaceNewsletterSendImageStorage).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for an image of another project, before touching storage", async () => {
		mocks.getNewsletterSendImage.mockResolvedValue(null);

		const error = await errorOf(
			replace({
				input: {
					projectId: "p1",
					imageId: "img-elsewhere",
					uploadToken: TOKEN,
				},
				context,
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.storage.getFileMetadata).not.toHaveBeenCalled();
	});
});

describe("sends.images.remove", () => {
	it("deletes the row, then its object", async () => {
		mocks.deleteNewsletterSendImage.mockResolvedValue({
			ok: true,
			storageKey: "org-9/newsletter-images/send-1/kept.png",
		});

		const result = await remove({
			input: { projectId: "p1", imageId: "img-1" },
			context,
		});

		expect(mocks.deleteNewsletterSendImage).toHaveBeenCalledWith({
			projectId: "p1",
			imageId: "img-1",
		});
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			["org-9/newsletter-images/send-1/kept.png"],
			{ bucket: BUCKET },
		);
		expect(result).toEqual({ imageId: "img-1", removed: true });
	});

	it("still succeeds when the object cannot be deleted", async () => {
		mocks.deleteNewsletterSendImage.mockResolvedValue({
			ok: true,
			storageKey: "org-9/newsletter-images/send-1/kept.png",
		});
		mocks.storage.deleteObjects.mockRejectedValue(
			new Error("storage down"),
		);

		await expect(
			remove({ input: { projectId: "p1", imageId: "img-1" }, context }),
		).resolves.toEqual({ imageId: "img-1", removed: true });
	});

	it("answers NOT_FOUND for an image of another project", async () => {
		mocks.deleteNewsletterSendImage.mockResolvedValue({
			ok: false,
			refusal: { reason: "IMAGE_NOT_FOUND" },
		});

		const error = await errorOf(
			remove({
				input: { projectId: "p1", imageId: "img-elsewhere" },
				context,
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.storage.deleteObjects).not.toHaveBeenCalled();
	});

	it("stops the capture of an image removed while it was being captured", async () => {
		mocks.getHandle.mockReturnValue({ cancel: mocks.workflowCancel });
		mocks.workflowCancel.mockResolvedValue(undefined);
		mocks.deleteNewsletterSendImage.mockResolvedValue({
			ok: true,
			storageKey: null,
			wasCapturing: true,
		});

		const result = await remove({
			input: { projectId: "p1", imageId: "img-1" },
			context,
		});

		expect(mocks.getHandle).toHaveBeenCalledWith(
			"newsletter-screenshot-capture-img-1",
		);
		expect(mocks.workflowCancel).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ imageId: "img-1", removed: true });
	});

	it("still removes the image when the capture cannot be stopped", async () => {
		mocks.getHandle.mockReturnValue({ cancel: mocks.workflowCancel });
		mocks.workflowCancel.mockRejectedValue(new Error("workflow not found"));
		mocks.deleteNewsletterSendImage.mockResolvedValue({
			ok: true,
			storageKey: null,
			wasCapturing: true,
		});

		await expect(
			remove({ input: { projectId: "p1", imageId: "img-1" }, context }),
		).resolves.toEqual({ imageId: "img-1", removed: true });
	});

	it("stops nothing for an image that was not being captured", async () => {
		mocks.deleteNewsletterSendImage.mockResolvedValue({
			ok: true,
			storageKey: "org-9/newsletter-images/send-1/kept.png",
			wasCapturing: false,
		});

		await remove({ input: { projectId: "p1", imageId: "img-1" }, context });

		expect(mocks.getHandle).not.toHaveBeenCalled();
	});
});

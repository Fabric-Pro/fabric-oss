/**
 * `sends.images.includeAll`, `sends.images.unpublish` and the placement
 * field of `sends.images.update`. Fully offline: `@repo/database` and the
 * storage provider are mocked, and each procedure's `.handler` is invoked
 * directly via the chainable-proxy `_handler` (same harness as
 * sends-images.test.ts).
 *
 * The row-locked writes run against real Postgres in
 * `packages/database/prisma/queries/projects/__tests__/newsletter-images.test.ts`.
 * Here: the permission, the project scoping, the refusals, and that a
 * takedown clears only the images whose public copy is really gone.
 *
 * Run with: pnpm --filter @repo/api test sends-images-review-actions
 */

import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
	permissions: [] as string[],
	projectFindUnique: vi.fn(),
	updateNewsletterSendImage: vi.fn(),
	includeAllNewsletterSendImages: vi.fn(),
	listPublishedNewsletterSendImages: vi.fn(),
	clearPublishedNewsletterSendImages: vi.fn(),
	storage: {
		getSignedUrl: vi.fn(),
		deleteObjects: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
	updateNewsletterSendImage: mocks.updateNewsletterSendImage,
	includeAllNewsletterSendImages: mocks.includeAllNewsletterSendImages,
	listPublishedNewsletterSendImages: mocks.listPublishedNewsletterSendImages,
	clearPublishedNewsletterSendImages:
		mocks.clearPublishedNewsletterSendImages,
	getNewsletterSendForSendPhase: vi.fn(),
	deleteDiscardedNewsletterSendImages: vi.fn(),
	listNewsletterSendImages: vi.fn(),
	removedHighlightIndexesSchema: z.array(z.number().int().min(0)).max(500),
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
		requireProjectPermission: (permission: string) => {
			mocks.permissions.push(permission);
			return (c: unknown) => c;
		},
	};
});

import { includeAllImagesProcedure } from "../sends-images-include-all";
import { unpublishImagesProcedure } from "../sends-images-unpublish";
import { updateImageProcedure } from "../sends-images-update";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const handlerOf = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;
const includeAll = handlerOf(includeAllImagesProcedure);
const unpublish = handlerOf(unpublishImagesProcedure);
const update = handlerOf(updateImageProcedure);

const BUCKET = config.storage.bucketNames.projectContexts;
const context = {
	user: { id: "reviewer-1", email: "r@example.com", name: "Reviewer" },
};
const REVIEWER = {
	userId: "reviewer-1",
	email: "r@example.com",
	name: "Reviewer",
};

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
	placement: "BELOW",
	errorMessage: null,
	...overrides,
});

const sendInput = (overrides: Record<string, unknown> = {}) => ({
	projectId: "p1",
	organizationId: "org-9",
	sendId: "send-1",
	...overrides,
});

async function errorOf(promise: Promise<unknown>) {
	const error = await promise.catch((e: unknown) => e);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<
		string,
		{ code?: string; currentStatus?: string; removed?: number }
	>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-9",
		userId: "owner-1",
	});
	mocks.storage.getSignedUrl.mockResolvedValue(
		"https://storage.example.com/get",
	);
	mocks.storage.deleteObjects.mockResolvedValue({ deleted: 2, errors: [] });
	mocks.listPublishedNewsletterSendImages.mockResolvedValue({
		ok: true,
		images: [
			{ id: "img-1", publicKey: "newsletter-public/a.png" },
			{ id: "img-2", publicKey: "newsletter-public/b.jpg" },
		],
	});
	mocks.clearPublishedNewsletterSendImages.mockImplementation(
		async (input: { imageIds: string[] }) => input.imageIds.length,
	);
});

describe("permissions", () => {
	it("every procedure requires the project settings edit permission", () => {
		expect(mocks.permissions).toEqual([
			"PROJECT_SETTINGS_EDIT",
			"PROJECT_SETTINGS_EDIT",
			"PROJECT_SETTINGS_EDIT",
		]);
	});
});

describe("sends.images.update — placement", () => {
	it("passes the placement through and returns it", async () => {
		mocks.updateNewsletterSendImage.mockResolvedValue({
			ok: true,
			image: imageRow({ placement: "ABOVE" }),
		});

		const result = (await update({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				imageId: "img-1",
				placement: "ABOVE",
			},
			context,
		})) as { image: { placement: string } };

		expect(mocks.updateNewsletterSendImage).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				imageId: "img-1",
				placement: "ABOVE",
			}),
		);
		expect(result.image.placement).toBe("ABOVE");
	});
});

describe("sends.images.includeAll", () => {
	it("includes the ready images of kept highlights and returns them", async () => {
		mocks.includeAllNewsletterSendImages.mockResolvedValue({
			ok: true,
			images: [imageRow(), imageRow({ id: "img-2", highlightIndex: 2 })],
		});

		const result = (await includeAll({
			input: sendInput({ removedHighlightIndexes: [1] }),
			context,
		})) as { images: Array<Record<string, unknown>> };

		expect(mocks.includeAllNewsletterSendImages).toHaveBeenCalledWith({
			projectId: "p1",
			sendId: "send-1",
			removedHighlightIndexes: [1],
		});
		expect(result.images.map((image) => image.id)).toEqual([
			"img-1",
			"img-2",
		]);
		expect(result.images[0]).not.toHaveProperty("storageKey");
		expect(result.images[0]?.url).toBe("https://storage.example.com/get");
	});

	it("answers CONFLICT when the send is no longer awaiting review", async () => {
		mocks.includeAllNewsletterSendImages.mockResolvedValue({
			ok: false,
			refusal: { reason: "NOT_PENDING", status: "APPROVED" },
		});

		const error = await errorOf(
			includeAll({
				input: sendInput({ removedHighlightIndexes: [] }),
				context,
			}),
		);

		expect(error.code).toBe("CONFLICT");
		expect(error.data?.currentStatus).toBe("APPROVED");
	});

	it("refuses a project the caller named under another organization", async () => {
		const error = await errorOf(
			includeAll({
				input: sendInput({
					organizationId: "org-other",
					removedHighlightIndexes: [],
				}),
				context,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.includeAllNewsletterSendImages).not.toHaveBeenCalled();
	});
});

describe("sends.images.unpublish", () => {
	it("deletes every public copy, then clears those images and records who did it", async () => {
		const result = await unpublish({ input: sendInput(), context });

		expect(mocks.listPublishedNewsletterSendImages).toHaveBeenCalledWith(
			"p1",
			"send-1",
		);
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			["newsletter-public/a.png", "newsletter-public/b.jpg"],
			{ bucket: BUCKET },
		);
		expect(mocks.clearPublishedNewsletterSendImages).toHaveBeenCalledWith({
			projectId: "p1",
			sendId: "send-1",
			imageIds: ["img-1", "img-2"],
			failedCount: 0,
			actor: REVIEWER,
		});
		const [deletedAt] =
			mocks.storage.deleteObjects.mock.invocationCallOrder;
		const [clearedAt] =
			mocks.clearPublishedNewsletterSendImages.mock.invocationCallOrder;
		expect(deletedAt).toBeLessThan(clearedAt);
		expect(result).toEqual({ removed: 2 });
	});

	it("keeps the key of an image whose copy could not be deleted, and fails", async () => {
		mocks.storage.deleteObjects.mockResolvedValue({
			deleted: 1,
			errors: [{ key: "newsletter-public/b.jpg", message: "denied" }],
		});

		const error = await errorOf(unpublish({ input: sendInput(), context }));

		expect(mocks.clearPublishedNewsletterSendImages).toHaveBeenCalledWith(
			expect.objectContaining({ imageIds: ["img-1"], failedCount: 1 }),
		);
		expect(error.code).toBe("INTERNAL_SERVER_ERROR");
		expect(error.data?.removed).toBe(1);
	});

	it("clears nothing when storage cannot be reached", async () => {
		mocks.storage.deleteObjects.mockRejectedValue(new Error("down"));

		const error = await errorOf(unpublish({ input: sendInput(), context }));

		expect(mocks.clearPublishedNewsletterSendImages).toHaveBeenCalledWith(
			expect.objectContaining({ imageIds: [], failedCount: 2 }),
		);
		expect(error.code).toBe("INTERNAL_SERVER_ERROR");
	});

	it("does nothing for a sent newsletter without published images", async () => {
		mocks.listPublishedNewsletterSendImages.mockResolvedValue({
			ok: true,
			images: [],
		});

		const result = await unpublish({ input: sendInput(), context });

		expect(result).toEqual({ removed: 0 });
		expect(mocks.storage.deleteObjects).not.toHaveBeenCalled();
		expect(mocks.clearPublishedNewsletterSendImages).not.toHaveBeenCalled();
	});

	it.each([
		[{ reason: "SEND_NOT_FOUND" }, "NOT_FOUND"],
		[{ reason: "NOT_SENT", status: "PENDING_APPROVAL" }, "CONFLICT"],
	])("refuses %o with %s and deletes nothing", async (refusal, code) => {
		mocks.listPublishedNewsletterSendImages.mockResolvedValue({
			ok: false,
			refusal,
		});

		const error = await errorOf(unpublish({ input: sendInput(), context }));

		expect(error.code).toBe(code);
		expect(mocks.storage.deleteObjects).not.toHaveBeenCalled();
	});
});

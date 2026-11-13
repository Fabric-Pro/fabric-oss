/**
 * `sends.reject` and the review images of the rejected send. Same offline
 * harness as sends-approve-images.test.ts; storage is mocked so the object
 * deletes can be observed and made to fail.
 *
 * Coverage:
 *  - A reject that flips the row removes the send's image rows (through the
 *    query, which only acts on a REJECTED or EXPIRED send) and deletes the
 *    objects those rows held.
 *  - A reject that changes nothing (already stopped, or raced) removes
 *    nothing.
 *  - A failure to remove the rows or the objects is logged and never fails
 *    the reject.
 *
 * Run with: pnpm --filter @repo/api test sends-reject-images
 */

import type { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	newsletterSendFindFirst: vi.fn(),
	rejectNewsletterSend: vi.fn(),
	deleteDiscardedNewsletterSendImages: vi.fn(),
	logWarn: vi.fn(),
	storage: {
		deleteObjects: vi.fn(),
		listObjects: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		newsletterSend: { findFirst: mocks.newsletterSendFindFirst },
	},
	rejectNewsletterSend: mocks.rejectNewsletterSend,
	deleteDiscardedNewsletterSendImages:
		mocks.deleteDiscardedNewsletterSendImages,
}));

vi.mock("@repo/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/storage")>()),
	getStorageProvider: () => mocks.storage,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mocks.logWarn, error: vi.fn() },
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

import { rejectSendProcedure } from "../sends-reject";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const reject = (rejectSendProcedure as unknown as { _handler: Handler })
	._handler;

const BUCKET = config.storage.bucketNames.projectContexts;
const context = {
	user: { id: "reviewer-1", email: "r@example.com", name: "Reviewer" },
};
const input = {
	projectId: "p1",
	organizationId: "org-9",
	sendId: "send-1",
};
const KEYS = [
	"org-9/newsletter-images/send-1/one.png",
	"org-9/newsletter-images/send-1/two.jpg",
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-9",
		userId: "u1",
	});
	mocks.newsletterSendFindFirst.mockResolvedValue({
		id: "send-1",
		status: "PENDING_APPROVAL",
	});
	mocks.rejectNewsletterSend.mockResolvedValue({ rejected: true });
	mocks.deleteDiscardedNewsletterSendImages.mockResolvedValue(KEYS);
	mocks.storage.deleteObjects.mockResolvedValue({ deleted: 2, errors: [] });
	mocks.storage.listObjects.mockResolvedValue({ objects: [] });
});

describe("sends.reject — review images", () => {
	it("removes the rejected send's image rows, then their objects", async () => {
		const result = await reject({ input, context });

		expect(result).toMatchObject({ rejected: true, outcome: "rejected" });
		expect(mocks.deleteDiscardedNewsletterSendImages).toHaveBeenCalledWith(
			"p1",
			"send-1",
		);
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(KEYS, {
			bucket: BUCKET,
		});
		expect(mocks.storage.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				bucket: BUCKET,
				prefix: expect.stringMatching(/newsletter-images\/send-1\/$/),
			}),
		);
	});

	it("deletes an upload that was started but never added", async () => {
		const upload = "org-9/u1/newsletter-images/send-1/pending/abc";
		mocks.deleteDiscardedNewsletterSendImages.mockResolvedValue([]);
		mocks.storage.listObjects.mockResolvedValue({
			objects: [{ key: upload, lastModified: new Date(), size: 10 }],
		});

		await reject({ input, context });

		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith([upload], {
			bucket: BUCKET,
		});
	});

	it("touches no storage when the send had no images", async () => {
		mocks.deleteDiscardedNewsletterSendImages.mockResolvedValue([]);

		await reject({ input, context });

		expect(mocks.storage.deleteObjects).not.toHaveBeenCalled();
	});

	it.each(["REJECTED", "EXPIRED"])(
		"removes nothing when the send was already stopped (%s)",
		async (status) => {
			mocks.newsletterSendFindFirst.mockResolvedValue({
				id: "send-1",
				status,
			});

			const result = await reject({ input, context });

			expect(result).toMatchObject({ outcome: "already_resolved" });
			expect(
				mocks.deleteDiscardedNewsletterSendImages,
			).not.toHaveBeenCalled();
			expect(mocks.storage.deleteObjects).not.toHaveBeenCalled();
		},
	);

	it("removes nothing when the reject loses the race", async () => {
		mocks.newsletterSendFindFirst
			.mockResolvedValueOnce({ id: "send-1", status: "PENDING_APPROVAL" })
			.mockResolvedValueOnce({ status: "APPROVED" });
		mocks.rejectNewsletterSend.mockResolvedValue({ rejected: false });

		const error = await reject({ input, context }).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect(
			mocks.deleteDiscardedNewsletterSendImages,
		).not.toHaveBeenCalled();
		expect(mocks.storage.deleteObjects).not.toHaveBeenCalled();
	});

	it("still rejects when the image rows cannot be removed", async () => {
		mocks.deleteDiscardedNewsletterSendImages.mockRejectedValue(
			new Error("db blip"),
		);

		const result = await reject({ input, context });

		expect(result).toMatchObject({ rejected: true, outcome: "rejected" });
		expect(mocks.logWarn).toHaveBeenCalled();
		expect(mocks.storage.deleteObjects).not.toHaveBeenCalled();
	});

	it("still rejects when the objects cannot be deleted", async () => {
		mocks.storage.deleteObjects.mockRejectedValue(
			new Error("storage down"),
		);

		const result = await reject({ input, context });

		expect(result).toMatchObject({ rejected: true, outcome: "rejected" });
		expect(mocks.logWarn).toHaveBeenCalled();
	});
});

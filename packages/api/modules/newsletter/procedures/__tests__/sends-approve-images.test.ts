/**
 * `sends.approve` with the reviewer's highlight order and review images.
 * Same offline harness as sends-approve.test.ts; storage is mocked so the
 * publish copies can be observed and made to fail.
 *
 * Coverage:
 *  - `highlightOrder` is validated against the frozen highlights (in range,
 *    no duplicates; a partial order is fine) before anything is published or
 *    transitioned, and is passed through to `approveNewsletterSend`.
 *  - Only included, READY images under highlights the reviewer kept are
 *    copied to an unguessable `newsletter-public/` key, and their public URL
 *    is the app's image proxy.
 *  - One failed copy skips that image and the approval still goes through.
 *  - A published copy the approval did not embed is deleted; the review
 *    objects are kept, because the pending list still signs them while the
 *    approved send goes out.
 *  - A send without images publishes nothing.
 *
 * Run with: pnpm --filter @repo/api test sends-approve-images
 */

import type { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	getNewsletterSendForSendPhase: vi.fn(),
	approveNewsletterSend: vi.fn(),
	listNewsletterSendImages: vi.fn(),
	releaseStaleNewsletterCaptures: vi.fn(),
	countCapturingNewsletterImages: vi.fn(),
	isTemporalAvailable: vi.fn(),
	workflowStart: vi.fn(),
	logWarn: vi.fn(),
	storage: {
		copyFile: vi.fn(),
		deleteObjects: vi.fn(),
	},
}));

vi.mock("@temporalio/client", () => ({
	WorkflowExecutionAlreadyStartedError: class extends Error {},
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
	getNewsletterSendForSendPhase: mocks.getNewsletterSendForSendPhase,
	approveNewsletterSend: mocks.approveNewsletterSend,
	listNewsletterSendImages: mocks.listNewsletterSendImages,
	releaseStaleNewsletterCaptures: mocks.releaseStaleNewsletterCaptures,
	countCapturingNewsletterImages: mocks.countCapturingNewsletterImages,
	removedHighlightIndexesSchema: z.array(z.number().int().min(0)).max(500),
	newsletterContentSchema: { parse: (v: unknown) => v },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: { start: mocks.workflowStart },
	}),
	isTemporalAvailable: mocks.isTemporalAvailable,
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

import { approveSendProcedure } from "../sends-approve";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const approve = (approveSendProcedure as unknown as { _handler: Handler })
	._handler;

const BUCKET = config.storage.bucketNames.projectContexts;
const context = {
	user: { id: "reviewer-1", email: "r@example.com", name: "Reviewer" },
};

const heldRow = (overrides: Record<string, unknown> = {}) => ({
	id: "send-1",
	projectId: "p1",
	organizationId: "org-9",
	userId: null,
	status: "PENDING_APPROVAL",
	content: {
		highlights: [{ title: "a" }, { title: "b" }, { title: "c" }],
	},
	deliveryDestination: "EMAIL",
	chatChannels: [],
	removedHighlightIndexes: [],
	highlightOrder: null,
	screenshotsEnabled: true,
	timeWindowEnd: new Date("2026-11-01T00:00:00.000Z"),
	...overrides,
});

const image = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	sendId: "send-1",
	highlightIndex: 0,
	position: 0,
	captureState: "READY",
	included: true,
	source: "UPLOAD",
	storageKey: `org-9/newsletter-images/send-1/${id}.png`,
	altText: "",
	width: null,
	height: null,
	bytes: 1000,
	errorMessage: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	...overrides,
});

const input = (overrides: Record<string, unknown> = {}) => ({
	projectId: "p1",
	organizationId: "org-9",
	sendId: "send-1",
	removedHighlightIndexes: [],
	...overrides,
});

type Published = {
	imageId: string;
	storageKey: string;
	publicKey: string;
	url: string;
};
const publishedArg = (): Published[] =>
	mocks.approveNewsletterSend.mock.calls[0][0].publishedImages;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "p1",
		name: "Example",
		organizationId: "org-9",
	});
	mocks.getNewsletterSendForSendPhase.mockResolvedValue(heldRow());
	mocks.listNewsletterSendImages.mockResolvedValue([]);
	mocks.releaseStaleNewsletterCaptures.mockResolvedValue(0);
	mocks.countCapturingNewsletterImages.mockResolvedValue(0);
	mocks.isTemporalAvailable.mockResolvedValue(true);
	mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });
	mocks.storage.copyFile.mockResolvedValue(undefined);
	mocks.storage.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
	mocks.approveNewsletterSend.mockImplementation(
		async (args: { publishedImages: Published[] }) => ({
			approved: true,
			embeddedImageIds: args.publishedImages.map((p) => p.imageId),
		}),
	);
});

describe("sends.approve — highlightOrder", () => {
	it("passes a valid full order through to the transition", async () => {
		await approve({ input: input({ highlightOrder: [2, 0, 1] }), context });

		expect(mocks.approveNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({ highlightOrder: [2, 0, 1] }),
		);
	});

	it("accepts a partial order", async () => {
		await approve({ input: input({ highlightOrder: [2] }), context });

		expect(mocks.approveNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({ highlightOrder: [2] }),
		);
	});

	it.each([
		["a duplicate", [1, 1, 0]],
		["an index out of range", [0, 3]],
	])(
		"refuses an order with %s, before publishing or transitioning",
		async (_label, order) => {
			mocks.listNewsletterSendImages.mockResolvedValue([image("img-1")]);

			const error = await approve({
				input: input({ highlightOrder: order }),
				context,
			}).catch((e: unknown) => e);

			expect((error as ORPCError<string, unknown>).code).toBe(
				"BAD_REQUEST",
			);
			expect(mocks.storage.copyFile).not.toHaveBeenCalled();
			expect(mocks.approveNewsletterSend).not.toHaveBeenCalled();
		},
	);
});

describe("sends.approve — review images", () => {
	it("publishes only included, READY images under kept highlights", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([
			image("kept"),
			image("excluded", { included: false }),
			image("capturing", { captureState: "CAPTURING", storageKey: null }),
			image("failed", { captureState: "FAILED" }),
			image("under-removed", { highlightIndex: 1 }),
			image("jpeg", {
				highlightIndex: 2,
				storageKey: "org-9/x/jpeg.jpg",
			}),
		]);

		await approve({
			input: input({ removedHighlightIndexes: [1] }),
			context,
		});

		const copied = mocks.storage.copyFile.mock.calls.map((call) => call[0]);
		expect(copied).toEqual([
			"org-9/newsletter-images/send-1/kept.png",
			"org-9/x/jpeg.jpg",
		]);
		const published = publishedArg();
		expect(published.map((p) => p.imageId)).toEqual(["kept", "jpeg"]);
		expect(published[0].publicKey).toMatch(
			/^newsletter-public\/[0-9a-f]{32}\.png$/,
		);
		expect(published[1].publicKey).toMatch(
			/^newsletter-public\/[0-9a-f]{32}\.jpg$/,
		);
		expect(published[0].url).toMatch(
			new RegExp(`/image-proxy/${BUCKET}/${published[0].publicKey}$`),
		);
		expect(mocks.storage.copyFile).toHaveBeenCalledWith(
			"org-9/newsletter-images/send-1/kept.png",
			published[0].publicKey,
			{ bucket: BUCKET },
		);
	});

	it("reuses the public key an earlier publish recorded", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([
			image("published", { publicKey: "newsletter-public/existing.png" }),
		]);

		await approve({ input: input(), context });

		expect(mocks.storage.copyFile).toHaveBeenCalledWith(
			"org-9/newsletter-images/send-1/published.png",
			"newsletter-public/existing.png",
			{ bucket: BUCKET },
		);
		expect(publishedArg()[0].publicKey).toBe(
			"newsletter-public/existing.png",
		);
	});

	it("skips an image whose copy fails and still approves and dispatches", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([
			image("broken"),
			image("fine", { highlightIndex: 2 }),
		]);
		mocks.storage.copyFile
			.mockRejectedValueOnce(new Error("storage down"))
			.mockResolvedValueOnce(undefined);

		const result = await approve({ input: input(), context });

		expect(publishedArg().map((p) => p.imageId)).toEqual(["fine"]);
		expect(mocks.logWarn).toHaveBeenCalled();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ approved: true, outcome: "approved" });
	});

	it("approves without images when the image list cannot be read", async () => {
		mocks.listNewsletterSendImages.mockRejectedValue(new Error("db blip"));

		await approve({ input: input(), context });

		expect(publishedArg()).toEqual([]);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("deletes a published copy the approval did not embed", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([
			image("embedded"),
			image("changed-meanwhile", { highlightIndex: 2 }),
		]);
		mocks.approveNewsletterSend.mockImplementation(async () => ({
			approved: true,
			embeddedImageIds: ["embedded"],
		}));

		await approve({ input: input(), context });

		const orphan = publishedArg().find(
			(p) => p.imageId === "changed-meanwhile",
		);
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[orphan?.publicKey],
			{ bucket: BUCKET },
		);
	});

	it("keeps the review objects, which the pending list still shows while the send goes out", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([
			image("embedded"),
			image("excluded", { included: false }),
		]);

		await approve({ input: input(), context });

		expect(publishedArg().map((p) => p.imageId)).toEqual(["embedded"]);
		expect(mocks.storage.deleteObjects).not.toHaveBeenCalledWith(
			expect.arrayContaining([expect.stringMatching(/^org-9\//)]),
			expect.anything(),
		);
	});

	it("deletes every published copy when the approval loses the race", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([image("img-1")]);
		mocks.approveNewsletterSend.mockResolvedValue({
			approved: false,
			embeddedImageIds: [],
		});
		mocks.getNewsletterSendForSendPhase
			.mockResolvedValueOnce(heldRow())
			.mockResolvedValueOnce(heldRow({ status: "REJECTED" }));

		const error = await approve({ input: input(), context }).catch(
			(e: unknown) => e,
		);

		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[publishedArg()[0].publicKey],
			{ bucket: BUCKET },
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("publishes nothing for a send without images", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			heldRow({ screenshotsEnabled: false }),
		);

		await approve({ input: input(), context });

		expect(mocks.listNewsletterSendImages).not.toHaveBeenCalled();
		expect(mocks.storage.copyFile).not.toHaveBeenCalled();
		expect(publishedArg()).toEqual([]);
	});

	it("refuses while a screenshot is still being captured, before publishing", async () => {
		mocks.countCapturingNewsletterImages.mockResolvedValue(1);
		mocks.listNewsletterSendImages.mockResolvedValue([image("img-1")]);

		const error = await approve({ input: input(), context }).catch(
			(e: unknown) => e,
		);

		expect(mocks.releaseStaleNewsletterCaptures).toHaveBeenCalledWith({
			projectId: "p1",
			sendId: "send-1",
		});
		expect(
			mocks.releaseStaleNewsletterCaptures.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.countCapturingNewsletterImages.mock.invocationCallOrder[0],
		);
		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect((error as Error).message).toBe(
			"Wait for the screenshots that are still being captured.",
		);
		expect(mocks.storage.copyFile).not.toHaveBeenCalled();
		expect(mocks.approveNewsletterSend).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("refuses when a capture started under the lock after the early check", async () => {
		mocks.listNewsletterSendImages.mockResolvedValue([image("img-1")]);
		mocks.approveNewsletterSend.mockResolvedValue({
			approved: false,
			embeddedImageIds: [],
			stillCapturing: true,
		});

		const error = await approve({ input: input(), context }).catch(
			(e: unknown) => e,
		);

		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect((error as Error).message).toBe(
			"Wait for the screenshots that are still being captured.",
		);
		expect(mocks.storage.deleteObjects).toHaveBeenCalledWith(
			[publishedArg()[0].publicKey],
			{ bucket: BUCKET },
		);
		expect(mocks.getNewsletterSendForSendPhase).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("re-kicks an already-approved send without publishing again", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			heldRow({ status: "APPROVED" }),
		);

		await approve({ input: input({ highlightOrder: [9, 9] }), context });

		expect(mocks.storage.copyFile).not.toHaveBeenCalled();
		expect(mocks.approveNewsletterSend).not.toHaveBeenCalled();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
});

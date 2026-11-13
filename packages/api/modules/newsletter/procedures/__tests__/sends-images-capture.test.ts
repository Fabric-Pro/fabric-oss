/**
 * `sends.images.regenerate` and `sends.images.capture` — screenshots a
 * reviewer asks for while a send is held. Fully offline: `@repo/database`,
 * Temporal and the capability gate are mocked, and each procedure's
 * `.handler` is invoked directly via the chainable-proxy `_handler` (same
 * harness as sends-images.test.ts).
 *
 * The row-locked checks (CAPTURING, the upload refusal, the per-highlight
 * cap) live in the query layer. Here: the permission, the early refusals,
 * the error each refusal maps to, the workflow start on the export queue, and
 * a failed start failing the image instead of leaving it capturing.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	permissions: [] as string[],
	projectFindUnique: vi.fn(),
	getNewsletterSendForSendPhase: vi.fn(),
	getNewsletterSendImage: vi.fn(),
	startNewsletterImageRecapture: vi.fn(),
	createPromptedNewsletterCapture: vi.fn(),
	failNewsletterImageCapture: vi.fn(),
	getNewsletterSettings: vi.fn(),
	releaseStaleNewsletterCaptures: vi.fn(),
	assertCapabilityAvailable: vi.fn(),
	isTemporalAvailable: vi.fn(),
	workflowStart: vi.fn(),
	getSignedUrl: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const schema = await vi.importActual<
		typeof import("@repo/database/src/newsletter-schema")
	>("@repo/database/src/newsletter-schema");
	return {
		db: { project: { findUnique: mocks.projectFindUnique } },
		getNewsletterSendForSendPhase: mocks.getNewsletterSendForSendPhase,
		getNewsletterSendImage: mocks.getNewsletterSendImage,
		startNewsletterImageRecapture: mocks.startNewsletterImageRecapture,
		createPromptedNewsletterCapture: mocks.createPromptedNewsletterCapture,
		failNewsletterImageCapture: mocks.failNewsletterImageCapture,
		getNewsletterSettings: mocks.getNewsletterSettings,
		releaseStaleNewsletterCaptures: mocks.releaseStaleNewsletterCaptures,
		deleteDiscardedNewsletterSendImages: vi.fn(),
		listNewsletterSendImages: vi.fn(),
		newsletterContentSchema: schema.newsletterContentSchema,
		NEWSLETTER_CAPTURE_BRIEF_MAX: schema.NEWSLETTER_CAPTURE_BRIEF_MAX,
	};
});

vi.mock("@repo/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/storage")>()),
	getStorageProvider: () => ({ getSignedUrl: mocks.getSignedUrl }),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	PROPOSAL_EXPORT_TASK_QUEUE: "proposal-export",
	isTemporalAvailable: mocks.isTemporalAvailable,
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../capabilities/assert", () => ({
	assertCapabilityAvailable: mocks.assertCapabilityAvailable,
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

import { captureImageProcedure } from "../sends-images-capture";
import { regenerateImageProcedure } from "../sends-images-regenerate";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const handlerOf = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;
const regenerate = handlerOf(regenerateImageProcedure);
const capture = handlerOf(captureImageProcedure);

const context = {
	user: { id: "reviewer-1", email: "jane.doe@example.com", name: "Reviewer" },
};

/** The actor the queries record a capture start against. */
const REVIEWER = {
	userId: "reviewer-1",
	email: "jane.doe@example.com",
	name: "Reviewer",
};

const heldSend = (overrides: Record<string, unknown> = {}) => ({
	id: "send-1",
	projectId: "p1",
	status: "PENDING_APPROVAL",
	screenshotsEnabled: true,
	screenshotEnvironmentId: "env-1",
	content: {
		schemaVersion: 1,
		headline: "November update",
		intro: "",
		hasMajorFeatures: true,
		highlights: [
			{ title: "Saved filters", description: "Filters can be saved." },
		],
	},
	...overrides,
});

const imageRow = (overrides: Record<string, unknown> = {}) => ({
	id: "img-1",
	sendId: "send-1",
	highlightIndex: 0,
	position: 0,
	captureState: "CAPTURING",
	included: false,
	source: "AI",
	storageKey: "org-9/newsletter-images/send-1/old.jpg",
	altText: "",
	prompt: "The filters panel.",
	errorMessage: null,
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
	mocks.getNewsletterSendForSendPhase.mockResolvedValue(heldSend());
	mocks.getNewsletterSendImage.mockResolvedValue(
		imageRow({ captureState: "READY" }),
	);
	mocks.startNewsletterImageRecapture.mockResolvedValue({
		ok: true,
		image: imageRow(),
	});
	mocks.createPromptedNewsletterCapture.mockResolvedValue({
		ok: true,
		image: imageRow({ id: "img-2", source: "PROMPT", storageKey: null }),
	});
	mocks.getNewsletterSettings.mockResolvedValue({
		screenshotsEnabled: true,
		screenshotEnvironmentId: "env-1",
	});
	mocks.releaseStaleNewsletterCaptures.mockResolvedValue(0);
	mocks.assertCapabilityAvailable.mockResolvedValue(undefined);
	mocks.isTemporalAvailable.mockResolvedValue(true);
	mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });
	mocks.getSignedUrl.mockResolvedValue("https://storage.example.com/get");
});

const regenerateInput = (overrides: Record<string, unknown> = {}) => ({
	projectId: "p1",
	organizationId: "org-9",
	imageId: "img-1",
	...overrides,
});

const captureInput = (overrides: Record<string, unknown> = {}) => ({
	projectId: "p1",
	organizationId: "org-9",
	sendId: "send-1",
	highlightIndex: 0,
	prompt: "The saved filters list.",
	...overrides,
});

describe("permissions", () => {
	it("both procedures require the project settings edit permission", () => {
		expect(mocks.permissions).toEqual([
			"PROJECT_SETTINGS_EDIT",
			"PROJECT_SETTINGS_EDIT",
		]);
	});
});

describe("sends.images.regenerate", () => {
	it("captures again on the export queue and keeps showing the current image", async () => {
		const result = (await regenerate({
			input: regenerateInput({ prompt: "The filters panel, open." }),
			context,
		})) as { image: { url: string | null; captureState: string } };

		expect(mocks.startNewsletterImageRecapture).toHaveBeenCalledWith({
			projectId: "p1",
			imageId: "img-1",
			prompt: "The filters panel, open.",
			actor: REVIEWER,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"captureNewsletterScreenshotWorkflow",
			expect.objectContaining({
				taskQueue: "proposal-export",
				workflowId: "newsletter-screenshot-capture-img-1",
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				// The activity's 5-minute schedule-to-close plus 2 minutes.
				workflowExecutionTimeout: "7m",
				args: [
					{
						imageId: "img-1",
						highlight: {
							title: "Saved filters",
							description: "Filters can be saved.",
						},
					},
				],
			}),
		);
		expect(result.image.captureState).toBe("CAPTURING");
		expect(result.image.url).toBe("https://storage.example.com/get");
	});

	it("is gated on the release-notes capability", async () => {
		mocks.assertCapabilityAvailable.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Unavailable" }),
		);

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.startNewsletterImageRecapture).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when the send is no longer awaiting review", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			heldSend({ status: "APPROVED" }),
		);

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("CONFLICT");
		expect(error.data?.currentStatus).toBe("APPROVED");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("answers CONFLICT with its own code while a capture is running", async () => {
		mocks.startNewsletterImageRecapture.mockResolvedValue({
			ok: false,
			refusal: { reason: "CAPTURE_IN_PROGRESS" },
		});

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("CONFLICT");
		expect(error.data?.code).toBe("capture_in_progress");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("refuses an uploaded image", async () => {
		mocks.startNewsletterImageRecapture.mockResolvedValue({
			ok: false,
			refusal: { reason: "NOT_CAPTURED" },
		});

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
	});

	it("refuses a send without a capture environment before changing the image", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			heldSend({ screenshotEnvironmentId: null }),
		);

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("no_capture_environment");
		expect(mocks.startNewsletterImageRecapture).not.toHaveBeenCalled();
	});

	it("settles a capture that stopped without a result before checking for a running one", async () => {
		await regenerate({ input: regenerateInput(), context });

		expect(mocks.releaseStaleNewsletterCaptures).toHaveBeenCalledWith({
			projectId: "p1",
			sendId: "send-1",
		});
		expect(
			mocks.releaseStaleNewsletterCaptures.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.startNewsletterImageRecapture.mock.invocationCallOrder[0],
		);
	});

	it.each([
		[
			"screenshots were turned off",
			{ screenshotsEnabled: false, screenshotEnvironmentId: "env-1" },
		],
		[
			"another environment was chosen",
			{ screenshotsEnabled: true, screenshotEnvironmentId: "env-2" },
		],
		[
			"the environment was cleared",
			{ screenshotsEnabled: true, screenshotEnvironmentId: null },
		],
	])("refuses when %s since the send was held", async (_label, settings) => {
		mocks.getNewsletterSettings.mockResolvedValue(settings);

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(mocks.getNewsletterSettings).toHaveBeenCalledWith("p1");
		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("no_capture_environment");
		expect(mocks.startNewsletterImageRecapture).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for another project's image", async () => {
		mocks.getNewsletterSendImage.mockResolvedValue(null);

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("NOT_FOUND");
	});

	it("refuses before changing the image when no worker can take the capture", async () => {
		mocks.isTemporalAvailable.mockResolvedValue(false);

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("SERVICE_UNAVAILABLE");
		expect(mocks.startNewsletterImageRecapture).not.toHaveBeenCalled();
	});

	it("fails the image with a reason when the workflow cannot be started", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("connection refused"));

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("INTERNAL_SERVER_ERROR");
		expect(mocks.failNewsletterImageCapture).toHaveBeenCalledWith({
			imageId: "img-1",
			reason: "The capture could not be started.",
		});
	});
});

describe("sends.images.capture", () => {
	it("adds a capture from the reviewer's words and starts it", async () => {
		const result = (await capture({ input: captureInput(), context })) as {
			image: { id: string; url: string | null };
		};

		expect(mocks.createPromptedNewsletterCapture).toHaveBeenCalledWith({
			projectId: "p1",
			sendId: "send-1",
			highlightIndex: 0,
			prompt: "The saved filters list.",
			actor: REVIEWER,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"captureNewsletterScreenshotWorkflow",
			expect.objectContaining({
				taskQueue: "proposal-export",
				args: [
					expect.objectContaining({
						imageId: "img-2",
					}),
				],
			}),
		);
		expect(result.image).toMatchObject({ id: "img-2", url: null });
	});

	it("refuses a highlight the held content does not have", async () => {
		const error = await errorOf(
			capture({ input: captureInput({ highlightIndex: 3 }), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.createPromptedNewsletterCapture).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when the send left review under the reviewer", async () => {
		mocks.createPromptedNewsletterCapture.mockResolvedValue({
			ok: false,
			refusal: { reason: "NOT_PENDING", status: "REJECTED" },
		});

		const error = await errorOf(
			capture({ input: captureInput(), context }),
		);

		expect(error.code).toBe("CONFLICT");
		expect(error.data?.currentStatus).toBe("REJECTED");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("refuses a full highlight with its code", async () => {
		mocks.createPromptedNewsletterCapture.mockResolvedValue({
			ok: false,
			refusal: { reason: "HIGHLIGHT_FULL" },
		});

		const error = await errorOf(
			capture({ input: captureInput(), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.data?.code).toBe("highlight_full");
	});

	it("refuses a send that does not take images", async () => {
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			heldSend({ screenshotsEnabled: false }),
		);

		const error = await errorOf(
			capture({ input: captureInput(), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.createPromptedNewsletterCapture).not.toHaveBeenCalled();
	});
});

describe("the capture limit", () => {
	const limitReached = {
		ok: false,
		refusal: { reason: "CAPTURE_LIMIT" },
	};
	const message =
		"This newsletter has reached its limit of screenshot captures. Upload an image instead.";

	it("refuses a new capture once the send's limit is reached", async () => {
		mocks.createPromptedNewsletterCapture.mockResolvedValue(limitReached);

		const error = await errorOf(
			capture({ input: captureInput(), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(message);
		expect(error.data?.code).toBe("capture_limit");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("refuses a capture again once the send's limit is reached", async () => {
		mocks.startNewsletterImageRecapture.mockResolvedValue(limitReached);

		const error = await errorOf(
			regenerate({ input: regenerateInput(), context }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(message);
		expect(error.data?.code).toBe("capture_limit");
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

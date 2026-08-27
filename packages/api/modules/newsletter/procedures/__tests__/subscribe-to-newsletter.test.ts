import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCreatePending,
	mockProjectFindUnique,
	mockSettingsFindUnique,
	mockSendEmail,
	mockRunInBackground,
	mockWarn,
} = vi.hoisted(() => ({
	mockCreatePending: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockSettingsFindUnique: vi.fn(),
	mockSendEmail: vi.fn().mockResolvedValue(true),
	mockRunInBackground: vi.fn(),
	mockWarn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createPendingPublicSubscriber: mockCreatePending,
	db: {
		project: { findUnique: mockProjectFindUnique },
		newsletterSettings: { findUnique: mockSettingsFindUnique },
	},
}));
vi.mock("@repo/mail", () => ({ sendEmail: mockSendEmail }));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://fabric.pro" }));
vi.mock("@repo/logs", () => ({
	logger: { warn: mockWarn, error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../weave/lib/run-in-background", () => ({
	runInBackground: mockRunInBackground,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...a: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return { rateLimitedPublicProcedure: chainable };
});

import { subscribeToNewsletter } from "../subscribe-to-newsletter";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const subscribe = (subscribeToNewsletter as unknown as { _handler: Handler })
	._handler;
const ctx = { locale: "en" };

describe("subscribe-to-newsletter (double opt-in)", () => {
	const ORIGINAL_FABRIC_MAIN = process.env.FABRIC_MAIN_PROJECT_ID;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FABRIC_MAIN_PROJECT_ID = "fabric-main";
		mockProjectFindUnique.mockResolvedValue({
			id: "fabric-main",
			organizationId: "org-9",
			userId: "owner-1",
		});
		mockSettingsFindUnique.mockResolvedValue({
			createdByUserId: "admin-1",
		});
	});

	afterEach(() => {
		if (ORIGINAL_FABRIC_MAIN === undefined) {
			delete process.env.FABRIC_MAIN_PROJECT_ID;
		} else {
			process.env.FABRIC_MAIN_PROJECT_ID = ORIGINAL_FABRIC_MAIN;
		}
	});

	it("normalizes the email, creates a pending row, and dispatches a confirm email on new", async () => {
		mockCreatePending.mockResolvedValue({
			created: true,
			token: "tok-1234567890",
		});
		const res = await subscribe({
			input: { email: "New@Example.com" },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		expect(mockCreatePending).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "fabric-main",
				email: "new@example.com",
				userId: null,
				organizationId: "org-9",
				createdByUserId: "admin-1",
			}),
		);
		expect(mockSendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "new@example.com",
				locale: "en",
				templateId: "newsletterConfirm",
				context: {
					confirmUrl:
						"https://fabric.pro/newsletter/confirm/tok-1234567890",
				},
			}),
		);
		expect(mockRunInBackground).toHaveBeenCalledTimes(1);
	});

	it("trims surrounding whitespace too", async () => {
		mockCreatePending.mockResolvedValue({
			created: true,
			token: "tok-1234567890",
		});
		await subscribe({
			input: { email: "  Spaced@Example.com  " },
			context: ctx,
		});
		expect(mockCreatePending).toHaveBeenCalledWith(
			expect.objectContaining({ email: "spaced@example.com" }),
		);
	});

	it("returns generic success and sends NO email when the row already exists", async () => {
		mockCreatePending.mockResolvedValue({ created: false, token: null });
		const res = await subscribe({
			input: { email: "existing@example.com" },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		expect(mockSendEmail).not.toHaveBeenCalled();
	});

	it("returns generic success and writes nothing when FABRIC_MAIN_PROJECT_ID is unset", async () => {
		process.env.FABRIC_MAIN_PROJECT_ID = "";
		const res = await subscribe({
			input: { email: "x@example.com" },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		expect(mockCreatePending).not.toHaveBeenCalled();
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockWarn).toHaveBeenCalled();
	});
});

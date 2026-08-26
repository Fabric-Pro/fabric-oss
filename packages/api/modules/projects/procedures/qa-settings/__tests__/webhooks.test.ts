import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: [] as Array<
		(args: {
			input: Record<string, unknown>;
			context: Record<string, unknown>;
		}) => Promise<unknown>
	>,
	mocks: {
		get: vi.fn(),
		create: vi.fn(),
		rotate: vi.fn(),
		updateExpiry: vi.fn(),
		revoke: vi.fn(),
		encrypt: vi.fn((secret: string) => `encrypted:${secret}`),
		audit: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getProjectQaWebhookConfiguration: (...args: unknown[]) =>
		mocks.get(...args),
	createProjectQaWebhookConfiguration: (...args: unknown[]) =>
		mocks.create(...args),
	rotateProjectQaWebhookSecret: (...args: unknown[]) => mocks.rotate(...args),
	updateProjectQaWebhookExpiry: (...args: unknown[]) =>
		mocks.updateExpiry(...args),
	revokeProjectQaWebhook: (...args: unknown[]) => mocks.revoke(...args),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (...args: unknown[]) => mocks.encrypt(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.audit(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (typeof handlers)[number]) => {
			handlers.push(handler);
			return { _handler: handler };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: () => ({}),
		Permissions: {
			PROJECT_SETTINGS_READ: "project-settings-read",
			PROJECT_SETTINGS_EDIT: "project-settings-edit",
		},
	};
});

await import("../webhooks");

const [, createWebhook, rotateWebhook, updateExpiry, revokeWebhook] = handlers;
const context = { user: { id: "user-1" }, headers: new Headers() };

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "webhook-1",
		projectId: "project-1",
		encryptedSecret: "encrypted:stored",
		secretHint: "ored",
		previousEncryptedSecret: null,
		previousSecretRetiresAt: null,
		expiresAt: null,
		lastDeliveryAt: null,
		deliveryCount: 0,
		lastError: null,
		lastErrorAt: null,
		userId: "user-1",
		organizationId: null,
		createdAt: new Date("2026-07-28T08:00:00Z"),
		updatedAt: new Date("2026-07-28T08:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.get.mockResolvedValue(null);
	mocks.create.mockImplementation(async (input: Record<string, unknown>) =>
		row({
			encryptedSecret: input.encryptedSecret,
			secretHint: input.secretHint,
			expiresAt: input.expiresAt,
		}),
	);
	mocks.rotate.mockImplementation(async (input: Record<string, unknown>) => ({
		status: "rotated",
		row: row({
			encryptedSecret: input.encryptedSecret,
			secretHint: input.secretHint,
			previousSecretRetiresAt: input.previousSecretRetiresAt,
		}),
	}));
	mocks.updateExpiry.mockResolvedValue(true);
	mocks.revoke.mockResolvedValue(true);
});

describe("project QA webhook secret lifecycle", () => {
	it("returns the generated secret once while persisting only encrypted material", async () => {
		const result = (await createWebhook({
			input: { projectId: "project-1", expiresAt: null },
			context,
		})) as { secret: string; secretHint: string };

		expect(result.secret).toHaveLength(43);
		expect(result.secretHint).toBe(result.secret.slice(-4));
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				encryptedSecret: `encrypted:${result.secret}`,
				secretHint: result.secret.slice(-4),
			}),
		);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(
			result.secret,
		);
	});

	it("refuses another rotation while the overlap window is active", async () => {
		mocks.rotate.mockResolvedValue({
			status: "overlap_active_or_conflict",
		});

		await expect(
			rotateWebhook({
				input: { projectId: "project-1", overlapMinutes: 60 },
				context,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rotates with an overlap deadline instead of invalidating the old secret immediately", async () => {
		const before = Date.now();
		const result = (await rotateWebhook({
			input: { projectId: "project-1", overlapMinutes: 60 },
			context,
		})) as { secret: string; previousSecretRetiresAt: Date };
		const after = Date.now();

		const rotation = mocks.rotate.mock.calls[0][0] as {
			previousSecretRetiresAt: Date;
		};
		expect(
			rotation.previousSecretRetiresAt.getTime(),
		).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
		expect(rotation.previousSecretRetiresAt.getTime()).toBeLessThanOrEqual(
			after + 60 * 60 * 1000,
		);
		expect(result.secret).toHaveLength(43);
		expect(mocks.audit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.qa_webhook.rotated",
				metadata: {
					previousSecretRetiresAt:
						rotation.previousSecretRetiresAt.toISOString(),
				},
			}),
		);
	});

	it("rejects a past expiry before mutating storage", async () => {
		await expect(
			updateExpiry({
				input: {
					projectId: "project-1",
					expiresAt: new Date(Date.now() - 1000).toISOString(),
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.updateExpiry).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("audits revocation without exposing a credential", async () => {
		await revokeWebhook({
			input: { projectId: "project-1" },
			context,
		});

		expect(mocks.audit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "project.qa_webhook.revoked",
				resource: {
					type: "project_qa_webhook",
					id: "project-1",
				},
			}),
		);
	});
});

/**
 * `settings.update` — the `screenshotsEnabled` switch (reviewers may attach
 * images that approval publishes under public URLs). Same offline harness as
 * settings-update-require-approval.test.ts.
 *
 * Coverage:
 *  - A real transition (either direction) writes exactly one
 *    `newsletter.screenshots.changed` audit row in the save's transaction,
 *    with the new value in metadata, and forwards the value to the upsert.
 *  - A same-value write emits none; omitting the field never reads or audits.
 *  - An audit failure aborts the save.
 *
 * Run with: pnpm --filter @repo/api test settings-update-screenshots
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const txFindUnique = vi.fn();
	return {
		projectFindUnique: vi.fn(),
		getNewsletterSettings: vi.fn(),
		upsertNewsletterSettings: vi.fn(),
		recordAuditTx: vi.fn(),
		getProjectEnvironment: vi.fn(),
		txFindUnique,
		transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
			cb({ newsletterSettings: { findUnique: txFindUnique } }),
		),
	};
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		$transaction: mocks.transaction,
	},
	getNewsletterSettings: mocks.getNewsletterSettings,
	upsertNewsletterSettings: mocks.upsertNewsletterSettings,
	enrollProjectMembersAsSubscribers: vi.fn(),
	setPublicWidgetState: vi.fn(),
	recordAuditTx: mocks.recordAuditTx,
	getProjectEnvironment: mocks.getProjectEnvironment,
	getLinkedTeamsChannels: vi.fn().mockResolvedValue([]),
	getLinkedSlackChannels: vi.fn().mockResolvedValue([]),
	NEWSLETTER_DETAIL_LEVELS: ["BRIEF", "STANDARD", "DETAILED"],
	DEFAULT_NEWSLETTER_DETAIL_LEVEL: "STANDARD",
	NEWSLETTER_DELIVERY_DESTINATIONS: ["EMAIL", "CHAT", "BOTH"],
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION: "EMAIL",
	NEWSLETTER_CHAT_PLATFORMS: ["TEAMS", "SLACK"],
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

import { updateSettingsProcedure } from "../settings-update";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const updateSettings = (
	updateSettingsProcedure as unknown as { _handler: Handler }
)._handler;

const context = {
	user: { id: "admin-1", email: "a@example.com", name: "A" },
};

const save = (screenshotsEnabled: boolean | undefined) =>
	updateSettings({
		input: {
			projectId: "p1",
			organizationId: "org-9",
			...(screenshotsEnabled === undefined
				? { cadence: "WEEKLY" }
				: { screenshotsEnabled }),
		},
		context,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
		cb({ newsletterSettings: { findUnique: mocks.txFindUnique } }),
	);
	mocks.projectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-9",
		userId: null,
	});
	mocks.getNewsletterSettings.mockResolvedValue({ enabled: false });
	mocks.upsertNewsletterSettings.mockResolvedValue({ id: "ns-1" });
	mocks.recordAuditTx.mockResolvedValue(undefined);
	mocks.txFindUnique.mockResolvedValue({ screenshotsEnabled: false });
});

describe("settings.update — screenshotsEnabled", () => {
	it.each([
		[false, true],
		[true, false],
	])(
		"%s -> %s: writes one newsletter.screenshots.changed row in the save's transaction",
		async (before, after) => {
			mocks.txFindUnique.mockResolvedValue({
				screenshotsEnabled: before,
			});

			await save(after);

			expect(mocks.txFindUnique).toHaveBeenCalledWith({
				where: { projectId: "p1" },
				select: { screenshotsEnabled: true },
			});
			expect(mocks.recordAuditTx).toHaveBeenCalledTimes(1);
			expect(mocks.recordAuditTx).toHaveBeenCalledWith(
				expect.objectContaining({
					newsletterSettings: expect.anything(),
				}),
				expect.objectContaining({
					action: "newsletter.screenshots.changed",
					actor: expect.objectContaining({
						type: "user",
						userId: "admin-1",
					}),
					organizationId: "org-9",
					projectId: "p1",
					resource: { type: "newsletter_settings", id: "p1" },
					metadata: { screenshotsEnabled: after },
				}),
			);
			expect(mocks.upsertNewsletterSettings).toHaveBeenCalledWith(
				"p1",
				expect.objectContaining({ screenshotsEnabled: after }),
				expect.anything(),
			);
		},
	);

	it("a same-value write emits no audit row", async () => {
		mocks.txFindUnique.mockResolvedValue({ screenshotsEnabled: true });

		await save(true);

		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("turning it off on a project with no settings row emits no audit row", async () => {
		mocks.txFindUnique.mockResolvedValue(null);

		await save(false);

		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("omitted: never reads the current value or audits, and leaves it unchanged", async () => {
		await save(undefined);

		expect(mocks.txFindUnique).not.toHaveBeenCalled();
		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
		expect(mocks.upsertNewsletterSettings).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ screenshotsEnabled: undefined }),
			expect.anything(),
		);
	});

	it("an audit failure aborts the save", async () => {
		mocks.recordAuditTx.mockRejectedValue(new Error("audit insert failed"));

		await expect(save(true)).rejects.toThrow("audit insert failed");
		expect(mocks.upsertNewsletterSettings).not.toHaveBeenCalled();
	});
});

describe("settings.update — screenshotEnvironmentId", () => {
	const chooseEnvironment = (input: Record<string, unknown>) =>
		updateSettings({
			input: { projectId: "p1", organizationId: "org-9", ...input },
			context,
		});

	beforeEach(() => {
		mocks.getProjectEnvironment.mockResolvedValue({ id: "env-1" });
		mocks.txFindUnique.mockResolvedValue({ screenshotEnvironmentId: null });
	});

	it("refuses an environment without the sample-data confirmation", async () => {
		const error = await chooseEnvironment({
			screenshotEnvironmentId: "env-1",
		}).catch((e: unknown) => e);

		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "sample_data_unconfirmed" },
		});
		expect(mocks.upsertNewsletterSettings).not.toHaveBeenCalled();
	});

	it("refuses an environment of another project", async () => {
		mocks.getProjectEnvironment.mockResolvedValue(null);

		const error = await chooseEnvironment({
			screenshotEnvironmentId: "env-other",
			screenshotSampleDataConfirmed: true,
		}).catch((e: unknown) => e);

		expect(mocks.getProjectEnvironment).toHaveBeenCalledWith({
			projectId: "p1",
			environmentId: "env-other",
		});
		expect(error).toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.upsertNewsletterSettings).not.toHaveBeenCalled();
	});

	it("refuses a production environment even with the confirmation", async () => {
		mocks.getProjectEnvironment.mockResolvedValue({
			id: "env-prod",
			type: "PRODUCTION",
		});

		const error = await chooseEnvironment({
			screenshotEnvironmentId: "env-prod",
			screenshotSampleDataConfirmed: true,
		}).catch((e: unknown) => e);

		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "production_environment" },
		});
		expect(mocks.upsertNewsletterSettings).not.toHaveBeenCalled();
		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("saves a confirmed environment with the confirmation time and one audit row", async () => {
		await chooseEnvironment({
			screenshotEnvironmentId: "env-1",
			screenshotSampleDataConfirmed: true,
		});

		expect(mocks.recordAuditTx).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "newsletter.screenshots.environment_changed",
				metadata: {
					screenshotEnvironmentId: "env-1",
					sampleDataConfirmed: true,
				},
			}),
		);
		expect(mocks.upsertNewsletterSettings).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({
				screenshotEnvironmentId: "env-1",
				screenshotSampleDataConfirmedAt: expect.any(Date),
			}),
			expect.anything(),
		);
	});

	it("clears the environment without a confirmation", async () => {
		mocks.txFindUnique.mockResolvedValue({
			screenshotEnvironmentId: "env-1",
		});

		await chooseEnvironment({ screenshotEnvironmentId: null });

		expect(mocks.getProjectEnvironment).not.toHaveBeenCalled();
		expect(mocks.upsertNewsletterSettings).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({
				screenshotEnvironmentId: null,
				screenshotSampleDataConfirmedAt: null,
			}),
			expect.anything(),
		);
		expect(mocks.recordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: {
					screenshotEnvironmentId: null,
					sampleDataConfirmed: false,
				},
			}),
		);
	});

	it("re-saving the same environment emits no audit row", async () => {
		mocks.txFindUnique.mockResolvedValue({
			screenshotEnvironmentId: "env-1",
		});

		await chooseEnvironment({
			screenshotEnvironmentId: "env-1",
			screenshotSampleDataConfirmed: true,
		});

		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
	});
});

/**
 * `releaseScreenshotEnvironment` — an environment whose address, sign-in
 * page, type or credential changed loses its place as the release-notes
 * screenshot environment: the binding and its sample-data confirmation are
 * cleared and audited in one transaction, and nothing is audited when the
 * project did not use that environment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const updateMany = vi.fn();
	const tx = { newsletterSettings: { updateMany } };
	return {
		tx,
		updateMany,
		recordAuditTx: vi.fn(),
		transaction: vi.fn(async (cb: (client: unknown) => unknown) => cb(tx)),
	};
});

vi.mock("@repo/database", () => ({
	db: { $transaction: mocks.transaction },
	recordAuditTx: mocks.recordAuditTx,
}));

import { releaseScreenshotEnvironment } from "../screenshot-environment";

const user = { id: "admin-1", email: "a@example.com", name: "A" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.recordAuditTx.mockResolvedValue(undefined);
});

describe("releaseScreenshotEnvironment", () => {
	it("clears the binding and its confirmation, and audits it in the same transaction", async () => {
		mocks.updateMany.mockResolvedValue({ count: 1 });

		const released = await releaseScreenshotEnvironment({
			projectId: "p1",
			environmentId: "env-1",
			user,
			changed: ["baseUrl"],
		});

		expect(released).toBe(true);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { projectId: "p1", screenshotEnvironmentId: "env-1" },
			data: {
				screenshotEnvironmentId: null,
				screenshotSampleDataConfirmedAt: null,
			},
		});
		expect(mocks.recordAuditTx).toHaveBeenCalledWith(mocks.tx, {
			action: "newsletter.screenshots.environment_changed",
			actor: {
				type: "user",
				userId: "admin-1",
				emailSnapshot: "a@example.com",
				nameSnapshot: "A",
			},
			projectId: "p1",
			resource: { type: "newsletter_settings", id: "p1" },
			metadata: {
				screenshotEnvironmentId: null,
				sampleDataConfirmed: false,
				releasedEnvironmentId: "env-1",
				environmentChanged: ["baseUrl"],
			},
		});
	});

	it("audits nothing when the project captures from another environment", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const released = await releaseScreenshotEnvironment({
			projectId: "p1",
			environmentId: "env-1",
			user,
			changed: ["credential"],
		});

		expect(released).toBe(false);
		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
	});

	it("an audit failure rolls the release back with it", async () => {
		mocks.updateMany.mockResolvedValue({ count: 1 });
		mocks.recordAuditTx.mockRejectedValue(new Error("audit insert failed"));

		await expect(
			releaseScreenshotEnvironment({
				projectId: "p1",
				environmentId: "env-1",
				user,
				changed: ["type"],
			}),
		).rejects.toThrow("audit insert failed");
	});
});

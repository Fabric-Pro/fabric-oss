import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	find: vi.fn(),
	access: vi.fn(),
	choices: vi.fn(),
	lock: vi.fn(),
	save: vi.fn(),
	audit: vi.fn(),
	query: vi.fn(),
	transaction: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		templateInstance: { findFirst: m.find },
		$queryRaw: m.query,
		$transaction: m.transaction,
	},
}));
vi.mock("../prisma/queries/lib/report-access", () => ({
	canAccessReportInstance: m.access,
}));
vi.mock("../prisma/queries/artifact-branding", () => ({
	getArtifactBrandingChoices: m.choices,
	lockArtifactBrandSelection: m.lock,
	ArtifactBrandingError: class extends Error {},
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: m.audit }));
vi.mock("../prisma/queries/reports", () => ({
	updateTemplateInstance: m.save,
	ReportInstanceConflictError: class extends Error {},
}));

import { db } from "../prisma/client";
import {
	applyReportInstanceBranding,
	getReportInstanceBranding,
} from "../prisma/queries/report-branding";

const actor = { userId: "example-user", organizationId: "example-org" };
const time = "2026-11-01T00:00:00.000Z";
const row = () => ({
	id: "example-report",
	sId: "example-stable",
	version: 3,
	userId: actor.userId,
	organizationId: actor.organizationId,
	updatedAt: new Date(time),
	template: { outputFormat: "MARKDOWN" },
	fabricConfig: {
		customSystemPrompt: "Retain instructions",
		reporting: {
			version: 1,
			period: "weekly",
			projectId: "example-project",
			timezone: "UTC",
			branding: { source: "COMPANY", expectedBrandVersion: 1 },
		},
	},
});
const input = {
	expectedInstanceVersion: 3,
	expectedUpdatedAt: time,
	branding: { source: "CLIENT" as const, expectedBrandVersion: 4 },
};
beforeEach(() => {
	vi.clearAllMocks();
	m.find.mockResolvedValue(row());
	m.access.mockResolvedValue(true);
	m.transaction.mockImplementation((work) => work(db));
	m.query.mockResolvedValue([]);
	m.lock.mockResolvedValue(undefined);
	m.choices.mockResolvedValue({
		company: { version: 1 },
		client: { version: 4 },
	});
	m.save.mockResolvedValue({
		...row(),
		updatedAt: new Date("2026-11-01T00:00:00.001Z"),
	});
});
describe("reviewed report branding", () => {
	it("reads the exact audience and reviewed record tokens", async () => {
		expect(
			await getReportInstanceBranding(actor, "example-report"),
		).toMatchObject({
			instanceVersion: 3,
			updatedAt: time,
			projectId: "example-project",
			canApply: true,
		});
		expect(m.find).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "example-report",
					organizationId: actor.organizationId,
				},
			}),
		);
		expect(m.choices).toHaveBeenCalledWith({
			...actor,
			projectId: "example-project",
		});
	});
	it("changes only branding through the same canonical writer and audits atomically", async () => {
		await applyReportInstanceBranding(actor, "example-report", input);
		expect(m.save).toHaveBeenCalledWith(
			{
				id: "example-report",
				expectedVersion: 3,
				expectedUpdatedAt: new Date(time),
				fabricConfig: {
					customSystemPrompt: "Retain instructions",
					reporting: expect.objectContaining({
						period: "weekly",
						projectId: "example-project",
						branding: input.branding,
					}),
				},
			},
			db,
		);
		expect(m.audit).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				action: "org.settings.updated",
				metadata: expect.objectContaining({
					operation: "report.branding.updated",
					brandSource: "CLIENT",
				}),
			}),
		);
	});
	it("removes branding without changing the audience or reporting period", async () => {
		await applyReportInstanceBranding(actor, "example-report", {
			...input,
			branding: null,
		});
		const config = m.save.mock.calls[0][0].fabricConfig;
		expect(config.reporting.period).toBe("weekly");
		expect(config.reporting.projectId).toBe("example-project");
		expect(config.reporting).not.toHaveProperty("branding");
	});
	it.each([
		{ ...input, expectedInstanceVersion: 2 },
		{ ...input, expectedUpdatedAt: "2026-10-31T00:00:00Z" },
	])("refuses stale instance tokens without writing", async (value) => {
		await expect(
			applyReportInstanceBranding(actor, "example-report", value),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.save).not.toHaveBeenCalled();
		expect(m.audit).not.toHaveBeenCalled();
	});
	it("denies revoked write access and a different bound project", async () => {
		m.access.mockResolvedValue(false);
		await expect(
			applyReportInstanceBranding(actor, "example-report", input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		m.access.mockResolvedValue(true);
		await expect(
			applyReportInstanceBranding(
				{ ...actor, boundProjectId: "example-other" },
				"example-report",
				input,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.save).not.toHaveBeenCalled();
	});
	it("rejects authority injection and unconfigured or unsupported reports", async () => {
		await expect(
			applyReportInstanceBranding(actor, "example-report", {
				...input,
				projectId: "example-other",
			} as any),
		).rejects.toThrow();
		m.find.mockResolvedValue({ ...row(), fabricConfig: null });
		await expect(
			applyReportInstanceBranding(actor, "example-report", input),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		m.find.mockResolvedValue({
			...row(),
			template: { outputFormat: "EVIDENCE_EMBED" },
		});
		await expect(
			applyReportInstanceBranding(actor, "example-report", input),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.save).not.toHaveBeenCalled();
	});
});

it("acquires the selected brand before the instance and repeats authority after locking", async () => {
	await applyReportInstanceBranding(actor, "example-report", input);
	expect(m.lock.mock.invocationCallOrder[0]).toBeLessThan(
		m.query.mock.invocationCallOrder[0],
	);
	expect(m.access).toHaveBeenCalledTimes(2);
	expect(m.save).toHaveBeenCalledOnce();
});

it("allows removal when a changed template no longer supports branded output", async () => {
	m.find.mockResolvedValue({
		...row(),
		template: { outputFormat: "EVIDENCE_EMBED" },
	});
	await expect(
		applyReportInstanceBranding(actor, "example-report", {
			...input,
			branding: null,
		}),
	).resolves.toMatchObject({ branding: null });
	expect(m.lock).not.toHaveBeenCalled();
	expect(m.save.mock.calls[0][0].fabricConfig.reporting).not.toHaveProperty(
		"branding",
	);
});

it("matches Portal access for a permitted teammate rather than imposing an owner-only branch", async () => {
	m.find.mockResolvedValue({ ...row(), userId: "example-other-author" });
	await expect(
		getReportInstanceBranding(actor, "example-report"),
	).resolves.toMatchObject({ instanceVersion: 3 });
	await expect(
		applyReportInstanceBranding(actor, "example-report", input),
	).resolves.toMatchObject({ branding: input.branding });
	expect(m.find).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				id: "example-report",
				organizationId: actor.organizationId,
			},
		}),
	);
});

it.each(["PDF", "MULTI_FORMAT"])(
	"supports reviewed branding for native %s document output",
	async (outputFormat) => {
		m.find.mockResolvedValue({ ...row(), template: { outputFormat } });
		await expect(
			applyReportInstanceBranding(actor, "example-report", input),
		).resolves.toMatchObject({ branding: input.branding });
		expect(m.lock).toHaveBeenCalled();
	},
);

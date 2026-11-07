import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	execution: vi.fn(),
	project: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
	execute: vi.fn(),
	prior: vi.fn(),
	frame: vi.fn(),
	insert: vi.fn(),
	audit: vi.fn(),
	lock: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		$transaction: async (fn: any) =>
			fn({
				$executeRaw: m.lock,
				$queryRaw: m.lock,
				templateInstanceExecution: { findFirst: m.execution },
				project: { findFirst: m.project },
				templateInstanceArtifact: {
					findFirst: m.prior,
					create: m.insert,
				},
			}),
	},
}));
vi.mock("../prisma/queries/frames", () => ({ createFrame: m.frame }));
vi.mock("../prisma/queries/projects/projects", () => ({
	hasProjectAccess: m.read,
	canEditProject: m.write,
}));
vi.mock("../prisma/queries/lib/report-access", () => ({
	canExecuteReportInstance: m.execute,
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: m.audit }));

import { storeBrandedReportArtifact } from "../prisma/queries/report-branded-artifacts";

const input = {
	executionId: "example-run",
	userId: "example-viewer",
	organizationId: "example-org",
	projectId: "example-project",
	name: "Weekly.md",
	artifactType: "MARKDOWN" as const,
	content: "# Weekly\nReviewed source",
	mimeType: "text/markdown",
};
beforeEach(() => {
	vi.clearAllMocks();
	m.execution.mockResolvedValue({
		status: "RUNNING",
		instance: { isActive: true },
		parameters: {},
	});
	m.project.mockResolvedValue({ id: input.projectId });
	m.read.mockResolvedValue(true);
	m.write.mockResolvedValue(false);
	m.execute.mockResolvedValue(true);
	m.prior.mockResolvedValue(null);
	m.frame.mockResolvedValue({
		id: "example-frame",
		updatedAt: new Date("2026-11-06T00:00:00Z"),
	});
	m.insert.mockResolvedValue({ id: "example-artifact" });
});
describe("report-derived immutable document publication", () => {
	it("permits a project reader with report execute permission without granting project edits", async () => {
		expect(await storeBrandedReportArtifact(input)).toMatchObject({
			id: "example-artifact",
		});
		expect(m.write).not.toHaveBeenCalled();
		expect(m.frame).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: input.projectId,
				sourceRunType: "REPORT_EXECUTION",
				sourceRunId: input.executionId,
				presentation: "DOCUMENT",
			}),
			expect.anything(),
		);
		expect(m.insert.mock.calls[0][0].data.metadata).toMatchObject({
			linkedFrameId: "example-frame",
			linkedFrameUpdatedAt: "2026-11-06T00:00:00.000Z",
		});
	});
	it.each(["project", "report"])(
		"refuses revoked %s access before creating any document",
		async (kind) => {
			if (kind === "project") {
				m.read.mockResolvedValue(false);
			} else {
				m.execute.mockResolvedValue(false);
			}
			await expect(storeBrandedReportArtifact(input)).rejects.toThrow(
				"revoked",
			);
			expect(m.frame).not.toHaveBeenCalled();
			expect(m.insert).not.toHaveBeenCalled();
		},
	);
	it("reuses existing output without creating duplicate Frames", async () => {
		m.prior.mockResolvedValue({ id: "example-prior" });
		expect(await storeBrandedReportArtifact(input)).toEqual({
			id: "example-prior",
		});
		expect(m.frame).not.toHaveBeenCalled();
	});
});

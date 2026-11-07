import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	publication: vi.fn(),
	find: vi.fn(),
	transaction: vi.fn(),
	run: vi.fn(),
	frame: vi.fn(),
	insert: vi.fn(),
	access: vi.fn(),
	audit: vi.fn(),
	getFrame: vi.fn(),
	render: vi.fn(),
	upload: vi.fn(),
	remove: vi.fn(),
	lock: vi.fn(),
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "example-private" } },
	},
}));
vi.mock("@repo/database", () => ({
	db: {
		templateInstanceArtifact: { findFirst: m.find },
		$transaction: m.transaction,
	},
	canExecuteReportInstance: m.access,
	recordAuditTx: m.audit,
}));
vi.mock("@repo/storage", () => ({
	uploadFile: m.upload,
	deleteFile: m.remove,
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			heartbeat: vi.fn(),
			cancellationSignal: new AbortController().signal,
		}),
	},
}));
vi.mock("../../frame-export/get-frame-content", () => ({
	getFrameContentActivity: m.getFrame,
}));
vi.mock("../../frame-export/generate-pdf", () => ({
	generatePDFActivity: m.render,
}));
vi.mock("../report-publication", () => ({
	loadReportPublication: m.publication,
}));

import { generateReportPdfArtifact } from "../generate-report-pdf";

const input = {
	executionId: "example-run",
	sourceArtifactId: "example-source",
	userId: "example-owner",
	organizationId: "example-org",
};
const revision = "2026-11-06T00:00:00.000Z";
const source = {
	id: input.sourceArtifactId,
	name: "Weekly.md",
	artifactType: "MARKDOWN",
	metadata: {
		linkedFrameId: "example-frame",
		linkedFrameUpdatedAt: revision,
	},
	description: "Reviewed weekly report",
};
const tx = {
	$queryRaw: m.lock,
	templateInstanceExecution: { findFirst: m.run },
	agentWorkspaceFile: { findFirst: m.frame },
	templateInstanceArtifact: { findFirst: vi.fn(), create: m.insert },
};
const pdf = Buffer.from("%PDF-1.7\nexample-bytes\n%%EOF");
beforeEach(() => {
	vi.clearAllMocks();
	m.publication.mockResolvedValue({
		execution: { instanceId: "example-report" },
	});
	m.find.mockImplementation(async (query) =>
		query.where.id ? source : null,
	);
	m.transaction.mockImplementation((fn) => fn(tx));
	m.run.mockResolvedValue({
		status: "RUNNING",
		instance: { isActive: true },
		parameters: {},
	});
	m.frame.mockResolvedValue({ id: "example-frame" });
	tx.templateInstanceArtifact.findFirst.mockResolvedValue(null);
	m.access.mockResolvedValue(true);
	m.getFrame.mockResolvedValue({
		document: {
			kind: "DOCUMENT",
			metadata: {
				sourceRunType: "REPORT_EXECUTION",
				sourceRunId: "example-run",
			},
			theme: { branding: { source: "CLIENT" } },
		},
	});
	m.render.mockResolvedValue(pdf);
	m.insert.mockImplementation(async ({ data }) => ({
		id: "example-pdf",
		...data,
	}));
	m.upload.mockResolvedValue(undefined);
	m.remove.mockResolvedValue(undefined);
});
describe("native report PDF publication", () => {
	it("renders the exact admitted Frame offline, stores real private bytes, and returns references only", async () => {
		const result = await generateReportPdfArtifact(input);
		const digest = createHash("sha256").update(pdf).digest("hex");
		expect(m.getFrame).toHaveBeenCalledWith({
			frameId: "example-frame",
			expectedUpdatedAt: revision,
			userId: input.userId,
			organizationId: input.organizationId,
		});
		expect(m.upload).toHaveBeenCalledWith(
			`report-artifacts/example-org/example-run/${digest}.pdf`,
			pdf,
			{
				bucket: "example-private",
				contentType: "application/pdf",
				access: "private",
			},
		);
		expect(m.insert.mock.calls[0][0].data).toMatchObject({
			artifactType: "PDF",
			mimeType: "application/pdf",
			size: pdf.length,
			metadata: {
				sourceArtifactId: source.id,
				sha256: digest,
				branding: { source: "CLIENT" },
			},
		});
		expect(result).toEqual({
			id: "example-pdf",
			name: "Weekly.pdf",
			artifactType: "PDF",
			mimeType: "application/pdf",
			size: pdf.length,
		});
		expect(JSON.stringify(result)).not.toContain("%PDF");
	});
	it("reuses an already persisted PDF after a lost activity result", async () => {
		m.find.mockImplementation(async (query) =>
			query.where.id
				? source
				: {
						id: "example-existing-pdf",
						name: "Weekly.pdf",
						size: pdf.length,
					},
		);
		expect(await generateReportPdfArtifact(input)).toMatchObject({
			id: "example-existing-pdf",
		});
		expect(m.render).not.toHaveBeenCalled();
		expect(m.upload).not.toHaveBeenCalled();
	});
	it("refuses a changed source Frame before any output upload", async () => {
		m.getFrame.mockRejectedValue(new Error("revision changed"));
		await expect(generateReportPdfArtifact(input)).rejects.toThrow(
			"revision changed",
		);
		expect(m.upload).not.toHaveBeenCalled();
		expect(m.insert).not.toHaveBeenCalled();
	});
	it.each(["cancellation", "frame"])(
		"refuses %s racing render and removes unpublished upload",
		async (kind) => {
			if (kind === "cancellation") {
				m.run.mockResolvedValue({
					status: "CANCELLED",
					instance: { isActive: true },
				});
			} else {
				m.frame.mockResolvedValue(null);
			}
			await expect(generateReportPdfArtifact(input)).rejects.toThrow();
			expect(m.insert).not.toHaveBeenCalled();
			expect(m.remove).toHaveBeenCalledWith(
				expect.stringMatching(/\.pdf$/),
				{ bucket: "example-private" },
			);
		},
	);
	it("rechecks actor access after rendering and before uploading", async () => {
		m.publication
			.mockResolvedValueOnce({
				execution: { instanceId: "example-report" },
			})
			.mockRejectedValue(new Error("access revoked"));
		await expect(generateReportPdfArtifact(input)).rejects.toThrow(
			"access revoked",
		);
		expect(m.upload).not.toHaveBeenCalled();
	});
});

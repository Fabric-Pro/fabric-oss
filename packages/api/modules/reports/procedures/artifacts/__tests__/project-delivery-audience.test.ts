import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
	artifact: vi.fn(),
	bindings: vi.fn(),
	access: vi.fn(),
	send: vi.fn(),
	download: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getTemplateInstanceArtifact: m.artifact,
	readReportProjectBindings: m.bindings,
	canAccessReportInstance: m.access,
	createTemplateInstanceArtifactEmailDeliveries: vi.fn(),
	db: { user: { findMany: vi.fn() } },
}));
vi.mock("@repo/mail", () => ({ sendEmail: m.send }));
vi.mock("@repo/storage", () => ({ downloadFile: m.download }));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: () => chain,
		handler: (run: unknown) => ({ _handler: run }),
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_SHARE: "share" },
		requireInputOrgPermission: () => () => {},
		resolveOrganizationId: () => "example-org",
	};
});
import { sendArtifactEmailProcedure } from "../send-email";
const invoke = (overrides: object = {}) =>
	(
		sendArtifactEmailProcedure as unknown as {
			_handler: (a: unknown) => Promise<unknown>;
		}
	)._handler({
		input: {
			artifactId: "example-artifact",
			recipientUserIds: ["example-reader"],
			recipientEmails: [],
			...overrides,
		},
		context: {
			user: { id: "example-sender" },
			session: { activeOrganizationId: "example-org" },
		},
	});
beforeEach(() => {
	vi.clearAllMocks();
	m.artifact.mockResolvedValue({
		organizationId: "example-org",
		userId: "example-sender",
		s3Path: "example/report.txt",
		s3Bucket: "example-reports",
		execution: {
			parameters: {},
			instance: {
				userId: "example-sender",
				organizationId: "example-org",
				fabricConfig: {},
			},
		},
	});
	m.bindings.mockReturnValue(["example-project"]);
	m.access.mockResolvedValue(false);
});
describe("restricted report sharing", () => {
	it("refuses unauthorized recipients before reading attachment bytes or sending messages", async () => {
		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.access).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-org" }),
			{ userId: "example-reader", organizationId: "example-org" },
			{},
		);
		expect(m.download).not.toHaveBeenCalled();
		expect(m.send).not.toHaveBeenCalled();
	});
	it("does not let a freeform email bypass project audience checks", async () => {
		await expect(
			invoke({ recipientEmails: ["reader@example.com"] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.download).not.toHaveBeenCalled();
		expect(m.send).not.toHaveBeenCalled();
	});
	it("fails closed on malformed current or admitted audience metadata", async () => {
		m.bindings.mockImplementation(() => {
			throw new Error("invalid scope");
		});
		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.send).not.toHaveBeenCalled();
	});
	it("does not reveal or fetch an artifact the sender cannot access", async () => {
		m.artifact.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.bindings).not.toHaveBeenCalled();
		expect(m.download).not.toHaveBeenCalled();
		expect(m.send).not.toHaveBeenCalled();
	});
});

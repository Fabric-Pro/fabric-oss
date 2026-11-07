import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	bindings: vi.fn(),
	audit: vi.fn(),
	artifact: vi.fn(),
	member: vi.fn(),
	notifications: vi.fn(),
	update: vi.fn(),
	lock: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		$transaction: async (fn: any) =>
			fn({
				$queryRaw: mocks.lock,
				templateInstanceArtifact: {
					findFirst: mocks.artifact,
					update: mocks.update,
				},
				member: { findUnique: mocks.member },
				notification: { createMany: mocks.notifications },
			}),
	},
}));
vi.mock("../prisma/queries/lib/report-access", () => ({
	canAccessReportInstance: mocks.access,
	readReportProjectBindings: mocks.bindings,
}));
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx: mocks.audit }));

import {
	distributeReportArtifact,
	reportArtifactHash,
	reportInboxDeliveryHistory,
} from "../prisma/queries/report-distribution";

const actor = { userId: "example-owner", organizationId: "example-org" };
const artifact = {
	id: "example-artifact",
	content: "Reviewed result",
	organizationId: "example-org",
	metadata: {
		branding: { source: "CLIENT" },
		linkedFrameId: "example-frame",
	},
	execution: {
		id: "example-execution",
		instanceId: "example-report",
		status: "COMPLETED",
		parameters: {},
		instance: {
			id: "example-report",
			organizationId: "example-org",
			name: "Weekly delivery",
		},
	},
};
const input = {
	artifactId: artifact.id,
	requestId: "00000000-0000-4000-8000-000000000001",
	expectedArtifactHash: reportArtifactHash(artifact)!,
	recipientUserIds: ["example-recipient"],
	message: "Please review",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue(true);
	mocks.bindings.mockReturnValue(["example-project"]);
	mocks.member.mockResolvedValue({ role: "owner" });
	mocks.artifact.mockResolvedValue(artifact);
	mocks.notifications.mockResolvedValue({ count: 1 });
	mocks.update.mockResolvedValue({});
});
describe("reviewed report inbox distribution", () => {
	it("commits exact run notification, bounded receipt and audit while retaining branding metadata", async () => {
		const result = await distributeReportArtifact(actor, input);
		expect(result).toMatchObject({
			replayed: false,
			recipientCount: 1,
			channel: "INBOX",
		});
		expect(mocks.lock).toHaveBeenCalled();
		expect(mocks.notifications.mock.calls[0][0].data[0]).toMatchObject({
			userId: "example-recipient",
			organizationId: "example-org",
			link: "report-templates/instances/example-report?tab=history&executionId=example-execution&artifactId=example-artifact",
		});
		const metadata = mocks.update.mock.calls[0][0].data.metadata;
		expect(metadata).toMatchObject(artifact.metadata);
		expect(reportInboxDeliveryHistory(metadata)[0]).toMatchObject({
			id: input.requestId,
			senderUserId: actor.userId,
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "report.artifact_distributed" }),
		);
	});
	it("reuses an uncertain delivery receipt without sending duplicate notifications", async () => {
		await distributeReportArtifact(actor, input);
		mocks.artifact.mockResolvedValue({
			...artifact,
			metadata: mocks.update.mock.calls[0][0].data.metadata,
		});
		mocks.notifications.mockClear();
		expect(await distributeReportArtifact(actor, input)).toMatchObject({
			replayed: true,
		});
		expect(mocks.notifications).not.toHaveBeenCalled();
		await expect(
			distributeReportArtifact(actor, { ...input, message: "different" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it.each(["artifact", "recipient", "role", "hash", "binding"])(
		"refuses changed %s without publishing notifications",
		async (kind) => {
			if (kind === "artifact") {
				mocks.artifact.mockResolvedValue({
					...artifact,
					execution: { ...artifact.execution, status: "CANCELLED" },
				});
			}
			if (kind === "recipient") {
				mocks.access
					.mockResolvedValueOnce(true)
					.mockResolvedValue(false);
			}
			if (kind === "role") {
				mocks.member.mockResolvedValue({ role: "guest" });
			}
			if (kind === "binding") {
				mocks.bindings.mockReturnValue(["example-other-project"]);
			}
			await expect(
				distributeReportArtifact(
					{
						...actor,
						...(kind === "binding"
							? { boundProjectId: "example-project" }
							: {}),
					},
					{
						...input,
						...(kind === "hash"
							? { expectedArtifactHash: "0".repeat(64) }
							: {}),
					},
				),
			).rejects.toThrow();
			expect(mocks.notifications).not.toHaveBeenCalled();
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);
	it("bounds explicit recipients and rejects unreviewed fields", async () => {
		await expect(
			distributeReportArtifact(actor, {
				...input,
				recipientUserIds: Array.from(
					{ length: 51 },
					(_, i) => `example-${i}`,
				),
			}),
		).rejects.toThrow();
		expect(
			reportArtifactHash({
				content: null,
				metadata: { sha256: "not-a-digest" },
			}),
		).toBeNull();
	});
});

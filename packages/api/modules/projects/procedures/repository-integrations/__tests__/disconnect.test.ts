import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectRepoIntegration: vi.fn(),
	deleteRepoIntegrationReleasingInstructionSync: vi.fn(),
	cleanupCodeSearchOnRepoUnlink: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnDisconnect: vi.fn(),
	deleteProjectCodeIndex: vi.fn(),
	cancelCodeIndexingForRepo: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	deleteRepoIntegrationReleasingInstructionSync:
		m.deleteRepoIntegrationReleasingInstructionSync,
	cleanupCodeSearchOnRepoUnlink: m.cleanupCodeSearchOnRepoUnlink,
	logRepoIntegrationActivity: m.logRepoIntegrationActivity,
	syncLegacyProjectRepoOnDisconnect: m.syncLegacyProjectRepoOnDisconnect,
	deleteProjectCodeIndex: m.deleteProjectCodeIndex,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: vi.fn() } }),
}));
vi.mock("@repo/rag", () => ({ deleteProjectCodeIndexVectors: vi.fn() }));
vi.mock("../../../lib/code-indexing-trigger", () => ({
	cancelCodeIndexingForRepo: m.cancelCodeIndexingForRepo,
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(o: T) => o,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => fn;
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? "org_1",
		Permissions: { PROJECT_SETTINGS_EDIT: "project:settings:edit" },
	};
});

import { disconnectRepoIntegrationProcedure } from "../disconnect";

const handler = disconnectRepoIntegrationProcedure as unknown as (args: {
	input: Record<string, unknown>;
	context: unknown;
}) => Promise<unknown>;
const ctx = { user: { id: "user_1", name: "Example Member" }, session: {} };

beforeEach(() => {
	for (const fn of Object.values(m)) fn.mockReset();
	m.getProjectRepoIntegration.mockResolvedValue({
		id: "int_1",
		provider: "GITHUB",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
	});
	m.cleanupCodeSearchOnRepoUnlink.mockResolvedValue({
		deletedContextQdrantIds: [],
		organizationId: "org_1",
	});
});

describe("repository integration disconnect: coding instructions sync (spec §5.1)", () => {
	it("releases the project's instruction sync in the same transaction and audits it as disabled", async () => {
		m.deleteRepoIntegrationReleasingInstructionSync.mockResolvedValue({
			deletedIntegration: true,
			releasedSync: { organizationId: "org_1" },
		});

		await handler({
			input: { projectId: "proj_1", integrationId: "int_1" },
			context: ctx,
		});

		expect(
			m.deleteRepoIntegrationReleasingInstructionSync,
		).toHaveBeenCalledWith({
			integrationId: "int_1",
			projectId: "proj_1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.repository_sync_disabled",
				organizationId: "org_1",
				projectId: "proj_1",
				metadata: {
					reason: "integration_disconnected",
					hadConfiguration: true,
				},
			}),
		);
	});

	it("writes no instructions audit when the integration was not the instruction source", async () => {
		m.deleteRepoIntegrationReleasingInstructionSync.mockResolvedValue({
			deletedIntegration: true,
			releasedSync: null,
		});
		await handler({
			input: { projectId: "proj_1", integrationId: "int_1" },
			context: ctx,
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.repository_sync_disabled",
			}),
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ action: "org.integration.disconnected" }),
		);
	});
});

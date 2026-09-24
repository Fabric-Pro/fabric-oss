/**
 * Repository integration disconnect and the two repository syncs that read
 * from an integration (design 2026-09-23 §2, §5.1): the Living Memory sync
 * (Fizzy #2657) and the coding-instructions sync (Fizzy #2538). Both are
 * released in the SAME transaction as the integration delete (one database
 * call), and each release is audited — the Living Memory one with the number
 * of files it kept as ordinary synced files, the instructions one as the
 * project's sync being disabled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectRepoIntegration: vi.fn(),
	deleteRepoIntegrationReleasingSyncs: vi.fn(),
	cleanupCodeSearchOnRepoUnlink: vi.fn(),
	logRepoIntegrationActivity: vi.fn(),
	syncLegacyProjectRepoOnDisconnect: vi.fn(),
	deleteProjectCodeIndex: vi.fn(),
	cancelCodeIndexingForRepo: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	deleteRepoIntegrationReleasingSyncs: m.deleteRepoIntegrationReleasingSyncs,
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
			orgId ?? "org-session",
		Permissions: { PROJECT_SETTINGS_EDIT: "project:settings:edit" },
	};
});

import { disconnectRepoIntegrationProcedure } from "../disconnect";

const handler = disconnectRepoIntegrationProcedure as unknown as (args: {
	input: Record<string, unknown>;
	context: unknown;
}) => Promise<unknown>;
const ctx = { user: { id: "user-1", name: "Example Member" }, session: {} };

const RELEASED_CONTEXT_SYNC = {
	syncId: "sync-1",
	organizationId: "org-host",
	managedCount: 4,
	activeRunKey: "sync-1:run-a",
};

const CONTEXT_SYNC_AUDIT = {
	action: "project.context.repository_sync_disabled",
	category: "project",
	organizationId: "org-host",
	projectId: "proj-1",
	resource: {
		type: "project_context_repository_sync",
		id: "sync-1",
		name: "example-org/memory",
	},
	metadata: {
		reason: "integration_disconnected",
		managedCount: 4,
	},
};

const INSTRUCTION_SYNC_AUDIT = {
	action: "project.instructions.repository_sync_disabled",
	category: "project",
	organizationId: "org-host",
	projectId: "proj-1",
	resource: { type: "project", id: "proj-1", name: null },
	metadata: {
		reason: "integration_disconnected",
		hadConfiguration: true,
	},
};

function released(
	overrides: {
		releasedInstructionSync?: { organizationId: string } | null;
		releasedContextSync?: typeof RELEASED_CONTEXT_SYNC | null;
	} = {},
) {
	m.deleteRepoIntegrationReleasingSyncs.mockResolvedValue({
		deletedIntegration: true,
		releasedInstructionSync: null,
		releasedContextSync: null,
		...overrides,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.getProjectRepoIntegration.mockResolvedValue({
		id: "int-1",
		provider: "GITHUB",
		repositoryUrl: "https://github.com/example-org/memory.git",
		repositoryOwner: "example-org",
		repositoryName: "memory",
	});
	m.cleanupCodeSearchOnRepoUnlink.mockResolvedValue({
		deletedContextQdrantIds: [],
		organizationId: "org-host",
	});
});

describe("repository integration disconnect: Living Memory repository sync (§5.1)", () => {
	it("deletes the sync configuration with the integration in one call and audits the release under the configuration's organization", async () => {
		released({ releasedContextSync: RELEASED_CONTEXT_SYNC });

		await expect(
			handler({
				input: { projectId: "proj-1", integrationId: "int-1" },
				context: ctx,
			}),
		).resolves.toEqual({ success: true });

		expect(m.deleteRepoIntegrationReleasingSyncs).toHaveBeenCalledTimes(1);
		expect(m.deleteRepoIntegrationReleasingSyncs).toHaveBeenCalledWith({
			integrationId: "int-1",
			projectId: "proj-1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			CONTEXT_SYNC_AUDIT,
		);
		// The disconnect's own audit row is unchanged.
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ action: "org.integration.disconnected" }),
		);
	});

	it("releases before the code-indexing teardown starts", async () => {
		released();

		await handler({
			input: { projectId: "proj-1", integrationId: "int-1" },
			context: ctx,
		});

		const [release] =
			m.deleteRepoIntegrationReleasingSyncs.mock.invocationCallOrder;
		const [cancel] = m.cancelCodeIndexingForRepo.mock.invocationCallOrder;
		expect(release).toBeLessThan(cancel as number);
	});

	it("writes no sync audit when the integration was not the sync source", async () => {
		released();

		await handler({
			input: { projectId: "proj-1", integrationId: "int-1" },
			context: ctx,
		});

		expect(m.recordAuditFromRequest).not.toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.context.repository_sync_disabled",
			}),
		);
	});

	it("touches nothing for an integration that is not this project's", async () => {
		m.getProjectRepoIntegration.mockResolvedValue(null);

		await expect(
			handler({
				input: { projectId: "proj-1", integrationId: "int-9" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.deleteRepoIntegrationReleasingSyncs).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("repository integration disconnect: coding instructions sync (spec §5.1)", () => {
	it("releases the project's instruction sync in the same transaction and audits it as disabled", async () => {
		released({ releasedInstructionSync: { organizationId: "org-host" } });

		await handler({
			input: { projectId: "proj-1", integrationId: "int-1" },
			context: ctx,
		});

		expect(m.deleteRepoIntegrationReleasingSyncs).toHaveBeenCalledTimes(1);
		expect(m.deleteRepoIntegrationReleasingSyncs).toHaveBeenCalledWith({
			integrationId: "int-1",
			projectId: "proj-1",
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.repository_sync_disabled",
				organizationId: "org-host",
				projectId: "proj-1",
				metadata: {
					reason: "integration_disconnected",
					hadConfiguration: true,
				},
			}),
		);
	});

	it("writes no instructions audit when the integration was not the instruction source", async () => {
		released();

		await handler({
			input: { projectId: "proj-1", integrationId: "int-1" },
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

describe("repository integration disconnect: both syncs on one integration", () => {
	it("releases both in one call and writes both audit rows", async () => {
		released({
			releasedInstructionSync: { organizationId: "org-host" },
			releasedContextSync: RELEASED_CONTEXT_SYNC,
		});

		await expect(
			handler({
				input: { projectId: "proj-1", integrationId: "int-1" },
				context: ctx,
			}),
		).resolves.toEqual({ success: true });

		expect(m.deleteRepoIntegrationReleasingSyncs).toHaveBeenCalledTimes(1);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			CONTEXT_SYNC_AUDIT,
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			INSTRUCTION_SYNC_AUDIT,
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ action: "org.integration.disconnected" }),
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(3);
	});
});

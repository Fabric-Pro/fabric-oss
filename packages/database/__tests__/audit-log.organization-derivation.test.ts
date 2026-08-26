/**
 * A project-scoped audit row must carry its project's organization, even when
 * the caller forgot to pass one.
 *
 * The organization audit log filters STRICTLY on `organizationId`. A row written
 * with `projectId` but no organization is persisted and then unreachable from
 * the only surface that exists to read it — which is what happened to every QA
 * event (a run dispatched, a credential changed, a CI run triggered) until each
 * call site was found and fixed by hand. Deriving it in the write path closes
 * the class rather than the instances.
 *
 * The personal-context case is the one to get wrong: a project with no
 * organization must still write NULL. That is the correct value there, not a
 * gap, and a derivation that invented an organization for it would break tenant
 * isolation in the audit log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	auditLogCreateMock: vi.fn(),
	projectFindUniqueMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		warn: mocks.loggerWarnMock,
		info: vi.fn(),
		log: vi.fn(),
	},
	logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/utils/correlation-id", () => ({
	getCorrelationIdFromContext: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../prisma/client", () => ({
	db: {
		auditLog: { create: (args: unknown) => mocks.auditLogCreateMock(args) },
		project: {
			findUnique: (args: unknown) => mocks.projectFindUniqueMock(args),
		},
	},
	Prisma: {},
}));

const { recordAuditDurable, recordAuditTx } = await import(
	"../prisma/queries/audit-log"
);

const ACTOR = { type: "user" as const, userId: "user-1" };

/** The `organization: { connect: { id } }` the row was built with, if any. */
function connectedOrganizationId(): string | undefined {
	const data = mocks.auditLogCreateMock.mock.calls.at(-1)?.[0]?.data;
	return data?.organization?.connect?.id;
}

beforeEach(() => {
	mocks.auditLogCreateMock.mockReset().mockResolvedValue({});
	mocks.projectFindUniqueMock.mockReset();
	mocks.loggerWarnMock.mockReset();
});

describe("audit organization derivation", () => {
	it("fills the organization from the project when the caller omitted it", async () => {
		mocks.projectFindUniqueMock.mockResolvedValue({
			organizationId: "org-1",
		});

		await recordAuditDurable({
			action: "project.agentic_run.dispatched",
			actor: ACTOR,
			projectId: "proj-1",
		});

		expect(connectedOrganizationId()).toBe("org-1");
	});

	it("leaves a personal-context project's row with no organization", async () => {
		// The project exists and genuinely has no organization. Inventing one here
		// would put a personal row into somebody's organization audit log.
		mocks.projectFindUniqueMock.mockResolvedValue({ organizationId: null });

		await recordAuditDurable({
			action: "project.agentic_run.dispatched",
			actor: ACTOR,
			projectId: "proj-personal",
		});

		expect(connectedOrganizationId()).toBeUndefined();
	});

	it("does not override an organization the caller passed explicitly", async () => {
		await recordAuditDurable({
			action: "project.agentic_run.dispatched",
			actor: ACTOR,
			projectId: "proj-1",
			organizationId: "org-explicit",
		});

		expect(connectedOrganizationId()).toBe("org-explicit");
		expect(mocks.projectFindUniqueMock).not.toHaveBeenCalled();
	});

	it("respects an explicit null as 'personal context', and does not override it", async () => {
		// `audit-error-middleware` returns null specifically to mean "the caller
		// said personal", as distinct from omitting the field. Deriving over that
		// would move a row into an organization its author kept it out of.
		await recordAuditDurable({
			action: "project.agentic_run.dispatched",
			actor: ACTOR,
			projectId: "proj-1",
			organizationId: null,
		});

		expect(mocks.projectFindUniqueMock).not.toHaveBeenCalled();
		expect(connectedOrganizationId()).toBeUndefined();
	});

	it("does not query at all for a row with no project", async () => {
		await recordAuditDurable({
			action: "org.member.invited",
			actor: ACTOR,
			organizationId: "org-1",
		});

		expect(mocks.projectFindUniqueMock).not.toHaveBeenCalled();
	});

	it("still writes the row when the project lookup fails", async () => {
		// An audit row with a null organization is bad. Losing the row entirely,
		// or failing the mutation it was auditing, is worse.
		mocks.projectFindUniqueMock.mockRejectedValue(new Error("db down"));

		await recordAuditDurable({
			action: "project.agentic_run.dispatched",
			actor: ACTOR,
			projectId: "proj-1",
		});

		expect(mocks.auditLogCreateMock).toHaveBeenCalledOnce();
		expect(connectedOrganizationId()).toBeUndefined();
		expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "audit.organization_derivation_failed",
			}),
			expect.any(String),
		);
	});

	it("reads the project through the caller's transaction, not a fresh connection", async () => {
		// A project created earlier in the SAME transaction is invisible outside
		// it, so a transactional audit row for it would lose its organization.
		const txCreate = vi.fn().mockResolvedValue({});
		const txFindUnique = vi
			.fn()
			.mockResolvedValue({ organizationId: "org-tx" });

		await recordAuditTx(
			{
				auditLog: { create: txCreate },
				project: { findUnique: txFindUnique },
			} as never,
			{
				action: "project.agentic_run.dispatched",
				actor: ACTOR,
				projectId: "proj-in-tx",
			},
		);

		expect(txFindUnique).toHaveBeenCalledOnce();
		expect(mocks.projectFindUniqueMock).not.toHaveBeenCalled();
		expect(txCreate.mock.calls[0][0].data.organization.connect.id).toBe(
			"org-tx",
		);
	});
});

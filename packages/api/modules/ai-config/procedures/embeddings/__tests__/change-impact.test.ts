import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	model: vi.fn(),
	readiness: vi.fn(),
	contexts: vi.fn(),
	documents: vi.fn(),
}));
vi.mock("../../../../../../database/prisma/client", () => ({
	db: {
		projectContext: { count: mocks.contexts },
		projectDocument: { count: mocks.documents },
	},
}));
vi.mock("@repo/database", async () => ({
	getIndexedProjectContentCount: (
		await import(
			"../../../../../../database/prisma/queries/embedding-change-impact"
		)
	).getIndexedProjectContentCount,
	getCompanyContextReadiness: mocks.readiness,
}));
vi.mock(
	"../../../../organizations/procedures/company-context/lib/source-state",
	() => ({ resolveCurrentCompanyModel: mocks.model }),
);
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, any> = {};
	for (const name of ["use", "route", "input", "output"]) {
		chain[name] = () => chain;
	}
	chain.handler = (fn: unknown) => ({ _handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requireInputOrgPermission: vi.fn(),
		Permissions: { ORG_AI_CONFIG_EDIT: "edit" },
		resolveOrganizationId: (
			input: string | undefined,
			session: { activeOrganizationId: string | null },
		) => input || session.activeOrganizationId || undefined,
	};
});

import { getEmbeddingChangeImpactProcedure } from "../change-impact";

const call = (organizationId: string | null = "example-org") =>
	(getEmbeddingChangeImpactProcedure as any)._handler({
		input: organizationId ? { organizationId } : {},
		context: {
			user: { id: "example-user" },
			session: { activeOrganizationId: organizationId },
		},
	});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.model.mockResolvedValue({
		identity: "OPENAI_DIRECT:example-embedding",
	});
	mocks.readiness.mockResolvedValue({ total: 5, ready: 2 });
	const projects = [
		{
			organizationId: "example-org",
			deletedAt: null,
			embeddedAt: new Date(),
			copiedOrg: null,
		},
		{
			organizationId: "example-other",
			deletedAt: null,
			embeddedAt: new Date(),
			copiedOrg: "example-org",
		},
		{
			organizationId: "example-org",
			deletedAt: new Date(),
			embeddedAt: new Date(),
		},
		{ organizationId: "example-org", deletedAt: null, embeddedAt: null },
	];
	const count = async ({ where }: any) =>
		projects.filter(
			(row) =>
				row.organizationId === where.project.organizationId &&
				(where.project.deletedAt !== null || row.deletedAt === null) &&
				(where.embeddedAt?.not !== null || row.embeddedAt !== null),
		).length;
	mocks.contexts.mockImplementation(count);
	mocks.documents.mockImplementation(count);
});
it("counts indexed content through the owning project's organization and excludes deleted projects", async () => {
	expect(await call()).toEqual({
		companyContext: { indexedWithCurrentModel: 2, total: 5 },
		projectContent: { indexed: 2 },
	});
	expect(mocks.readiness).toHaveBeenCalledWith(
		"example-org",
		"OPENAI_DIRECT:example-embedding",
	);
	expect(mocks.model).toHaveBeenCalledWith("example-org", "example-user");
	for (const count of [mocks.contexts, mocks.documents]) {
		expect(count).toHaveBeenCalledWith({
			where: {
				embeddedAt: { not: null },
				project: { organizationId: "example-org", deletedAt: null },
			},
		});
	}
});
it("returns zero company counts without a current model, retaining the model-independent project count", async () => {
	mocks.model.mockResolvedValue(null);
	expect(await call()).toEqual({
		companyContext: { indexedWithCurrentModel: 0, total: 0 },
		projectContent: { indexed: 2 },
	});
	expect(mocks.readiness).not.toHaveBeenCalled();
});
it("refuses an unresolved organization before reading content", async () => {
	await expect(call(null)).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mocks.model).not.toHaveBeenCalled();
	expect(mocks.contexts).not.toHaveBeenCalled();
});

it("uses the explicit requested organization ahead of the active session", async () => {
	await (getEmbeddingChangeImpactProcedure as any)._handler({
		input: { organizationId: "example-requested-org" },
		context: {
			user: { id: "example-user" },
			session: { activeOrganizationId: "example-session-org" },
		},
	});
	expect(mocks.model).toHaveBeenCalledWith(
		"example-requested-org",
		"example-user",
	);
});

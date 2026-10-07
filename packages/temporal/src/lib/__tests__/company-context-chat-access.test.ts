/**
 * Who may use company context in an Advisor chat, and for which organization
 * (Fizzy #2719).
 *
 * The resolver runs on every use — the hint and every search — and answers
 * with the organization, its display name and its ready-source count, or
 * nothing. These tests pin each fence:
 *
 *  - with a project, the organization is the project row's, never the
 *    request's; without one, it is the request's;
 *  - the person must be a MEMBER of that organization: a project guest is
 *    not, and the guest-inclusive tie is never consulted;
 *  - the `COMPANY_CONTEXT` gate is read for that organization;
 *  - "ready" is `companyContextReadyWhere` under the organization's current
 *    company embedding model, resolved before counting;
 *  - any failure is nothing, never an error and never the null-tenant arm.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/lib/__tests__/company-context-chat-access.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, logs } = vi.hoisted(() => ({
	mocks: {
		resolveProjectTenant: vi.fn(),
		isOrganizationMember: vi.fn(),
		hasOrganizationTie: vi.fn(),
		isFeatureEnabled: vi.fn(),
		organizationFindUnique: vi.fn(),
		companyContextSourceCount: vi.fn(),
		resolveCompanyEmbeddingModel: vi.fn(),
	},
	logs: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("@repo/logs", () => ({ logger: logs }));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			organization: {
				findUnique: (...args: unknown[]) =>
					mocks.organizationFindUnique(...args),
			},
			companyContextSource: {
				count: (...args: unknown[]) =>
					mocks.companyContextSourceCount(...args),
			},
		},
		resolveProjectTenant: (...args: unknown[]) =>
			mocks.resolveProjectTenant(...args),
		isOrganizationMember: (...args: unknown[]) =>
			mocks.isOrganizationMember(...args),
		hasOrganizationTie: (...args: unknown[]) =>
			mocks.hasOrganizationTie(...args),
		isFeatureEnabled: (...args: unknown[]) =>
			mocks.isFeatureEnabled(...args),
		// `companyContextReadyWhere` stays real: it is the one definition of
		// "ready" the count must use.
	};
});

// No `importOriginal`: the barrel boots the whole provider registry.
vi.mock("@repo/rag", () => ({
	resolveCompanyEmbeddingModel: (...args: unknown[]) =>
		mocks.resolveCompanyEmbeddingModel(...args),
}));

const { resolveCompanyContextChatAccess } = await import(
	"../company-context-chat-access"
);
const { companyContextReadyWhere } = await import("@repo/database");

const USER = "user-1";
const HOST_ORG = "org-host";
const OTHER_ORG = "org-other";
const PROJECT = "proj-1";
const MODEL_IDENTITY = "example-provider:example-embedding-model";

/** A member of every organization asked about, the gate on, two ready sources. */
function memberWithReadySources() {
	mocks.resolveProjectTenant.mockResolvedValue({
		organizationId: HOST_ORG,
		userId: null,
	});
	mocks.isOrganizationMember.mockResolvedValue(true);
	mocks.hasOrganizationTie.mockResolvedValue(true);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
		identity: MODEL_IDENTITY,
		dimensions: 1536,
		supported: true,
	});
	mocks.organizationFindUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) => ({
			name: where.id === HOST_ORG ? "Example Host" : "Example Other",
		}),
	);
	mocks.companyContextSourceCount.mockResolvedValue(2);
}

beforeEach(() => {
	vi.clearAllMocks();
	memberWithReadySources();
});

describe("resolveCompanyContextChatAccess", () => {
	it("answers a member's chat without a project with the request's organization, its name and its ready count", async () => {
		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
		});

		expect(access).toEqual({
			organizationId: HOST_ORG,
			organizationName: "Example Host",
			readySourceCount: 2,
		});
		expect(mocks.resolveProjectTenant).not.toHaveBeenCalled();
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(USER, HOST_ORG);
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			HOST_ORG,
		);
		expect(mocks.resolveCompanyEmbeddingModel).toHaveBeenCalledWith({
			organizationId: HOST_ORG,
			userId: USER,
		});
		// Ready under the organization's current model, and only its sources.
		expect(mocks.companyContextSourceCount).toHaveBeenCalledWith({
			where: {
				organizationId: HOST_ORG,
				...companyContextReadyWhere(MODEL_IDENTITY),
			},
		});
	});

	it("refuses a project guest chatting on a host project inside the host organization", async () => {
		mocks.isOrganizationMember.mockResolvedValue(false);

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
			projectId: PROJECT,
		});

		expect(access).toBeNull();
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(USER, HOST_ORG);
		// The guest-inclusive tie would admit them; it is never asked.
		expect(mocks.hasOrganizationTie).not.toHaveBeenCalled();
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
		expect(mocks.companyContextSourceCount).not.toHaveBeenCalled();
		expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
	});

	it("refuses a member of one organization chatting on another's project where they are only a guest", async () => {
		// Member of the other organization, guest on a host project.
		mocks.isOrganizationMember.mockImplementation(
			async (_userId: string, organizationId: string) =>
				organizationId === OTHER_ORG,
		);

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: OTHER_ORG,
			projectId: PROJECT,
		});

		expect(access).toBeNull();
		// The organization is the project's; their own is never considered.
		expect(mocks.isOrganizationMember).toHaveBeenCalledTimes(1);
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(USER, HOST_ORG);
		expect(mocks.hasOrganizationTie).not.toHaveBeenCalled();
		expect(mocks.companyContextSourceCount).not.toHaveBeenCalled();
	});

	it("uses the project's organization when the request names a different one", async () => {
		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: OTHER_ORG,
			projectId: PROJECT,
		});

		expect(mocks.resolveProjectTenant).toHaveBeenCalledWith(PROJECT);
		expect(access).toEqual({
			organizationId: HOST_ORG,
			organizationName: "Example Host",
			readySourceCount: 2,
		});
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(USER, HOST_ORG);
		expect(mocks.isOrganizationMember).not.toHaveBeenCalledWith(
			USER,
			OTHER_ORG,
		);
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			HOST_ORG,
		);
		expect(mocks.companyContextSourceCount).toHaveBeenCalledWith({
			where: {
				organizationId: HOST_ORG,
				...companyContextReadyWhere(MODEL_IDENTITY),
			},
		});
	});

	it("refuses when the gate is off for the organization", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
		});

		expect(access).toBeNull();
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			HOST_ORG,
		);
		expect(mocks.resolveCompanyEmbeddingModel).not.toHaveBeenCalled();
		expect(mocks.companyContextSourceCount).not.toHaveBeenCalled();
	});

	it("answers with a zero count when the organization has no ready source", async () => {
		mocks.companyContextSourceCount.mockResolvedValue(0);

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
		});

		expect(access).toEqual({
			organizationId: HOST_ORG,
			organizationName: "Example Host",
			readySourceCount: 0,
		});
	});

	it("refuses when the organization's embedding model cannot be resolved", async () => {
		mocks.resolveCompanyEmbeddingModel.mockRejectedValue(
			new Error("No embedding provider configured"),
		);

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
		});

		expect(access).toBeNull();
		expect(mocks.companyContextSourceCount).not.toHaveBeenCalled();
	});

	it("refuses when the organization's embedding model cannot be searched", async () => {
		mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
			identity: "example-provider:example-wide-model",
			dimensions: 3072,
			supported: false,
		});

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
		});

		expect(access).toBeNull();
		expect(mocks.companyContextSourceCount).not.toHaveBeenCalled();
	});

	it("refuses a chat with no project and no organization without checking membership", async () => {
		for (const requestOrganizationId of [undefined, null, ""]) {
			const access = await resolveCompanyContextChatAccess({
				userId: USER,
				requestOrganizationId,
				projectId: null,
			});
			expect(access).toBeNull();
		}

		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
	});

	// A hand-parsed request body can carry any JSON value. An object would
	// read as a Prisma filter and match every membership the caller has.
	it("treats an organization that is not a string as none, before any read", async () => {
		for (const requestOrganizationId of [
			{ not: "" },
			["org-host"],
			1,
			true,
		]) {
			const access = await resolveCompanyContextChatAccess({
				userId: USER,
				requestOrganizationId: requestOrganizationId as never,
			});
			expect(access, JSON.stringify(requestOrganizationId)).toBeNull();
		}

		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
		expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
		expect(mocks.companyContextSourceCount).not.toHaveBeenCalled();
	});

	it("refuses a person whose id is not a non-empty string, before any read", async () => {
		for (const userId of ["", undefined, null, { not: "" }, 1]) {
			const access = await resolveCompanyContextChatAccess({
				userId: userId as never,
				requestOrganizationId: HOST_ORG,
				projectId: PROJECT,
			});
			expect(access, JSON.stringify(userId)).toBeNull();
		}

		expect(mocks.resolveProjectTenant).not.toHaveBeenCalled();
		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		expect(mocks.companyContextSourceCount).not.toHaveBeenCalled();
	});

	it("refuses a project chat whose project has no organization, never falling back to the request's", async () => {
		for (const tenant of [
			null, // no such project
			{ organizationId: null, userId: USER }, // a personal project
		]) {
			mocks.resolveProjectTenant.mockResolvedValueOnce(tenant);

			const access = await resolveCompanyContextChatAccess({
				userId: USER,
				requestOrganizationId: HOST_ORG,
				projectId: PROJECT,
			});
			expect(access).toBeNull();
		}

		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
	});

	it("refuses when the organization row is gone", async () => {
		mocks.organizationFindUnique.mockResolvedValue(null);

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
		});

		expect(access).toBeNull();
	});

	it.each([
		["the project read", mocks.resolveProjectTenant],
		["the membership check", mocks.isOrganizationMember],
		["the gate read", mocks.isFeatureEnabled],
		["the model resolution", mocks.resolveCompanyEmbeddingModel],
		["the organization read", mocks.organizationFindUnique],
		["the ready count", mocks.companyContextSourceCount],
	])("refuses, without throwing, when %s fails", async (_step, failing) => {
		failing.mockRejectedValue(new Error("connection reset"));

		const access = await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
			projectId: PROJECT,
		});

		expect(access).toBeNull();
		expect(logs.warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				userId: USER,
				projectId: PROJECT,
				error: "connection reset",
			}),
		);
	});

	it("logs a refusal with ids and the reason only", async () => {
		mocks.isOrganizationMember.mockResolvedValue(false);

		await resolveCompanyContextChatAccess({
			userId: USER,
			requestOrganizationId: HOST_ORG,
			projectId: PROJECT,
		});

		const [, fields] = logs.info.mock.calls.at(-1) ?? [];
		expect(fields).toEqual({
			userId: USER,
			organizationId: HOST_ORG,
			projectId: PROJECT,
			reason: "not-a-member",
		});
	});
});

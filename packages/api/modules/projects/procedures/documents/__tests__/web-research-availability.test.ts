/**
 * `getWebResearchAvailabilityProcedure`: the project's organization decides,
 * never the caller.
 *
 * The oRPC builder is mocked as in the sibling tests (a chain that captures the
 * handler), but the middleware it captures is the REAL
 * `requireProjectPermission`, with only the database underneath mocked. So the
 * "refused before any provider read" cases run the actual permission
 * resolution, and they fail if the procedure stops registering it.
 *
 * The availability module and `@repo/search` registry are real too: the
 * answer below is computed the way it ships, from the mocked provider rows.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, captured } = vi.hoisted(() => ({
	mocks: {
		projectFindUnique: vi.fn(),
		memberFindFirst: vi.fn(),
		projectMemberFindUnique: vi.fn(),
		grantProjectAccess: vi.fn(),
		getEnabledOrganizationSearchProviders: vi.fn(),
		getEnabledUserSearchProviders: vi.fn(),
		decryptApiKey: vi.fn(),
	},
	captured: {
		middlewares: [] as unknown[],
		permissionTag: undefined as symbol | undefined,
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		member: { findFirst: mocks.memberFindFirst },
		projectMember: { findUnique: mocks.projectMemberFindUnique },
	},
	grantProjectAccess: mocks.grantProjectAccess,
	getEnabledOrganizationSearchProviders:
		mocks.getEnabledOrganizationSearchProviders,
	getEnabledUserSearchProviders: mocks.getEnabledUserSearchProviders,
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	decryptApiKey: mocks.decryptApiKey,
}));

vi.mock("../../../../../orpc/procedures", async () => {
	const real = await vi.importActual<
		typeof import("../../../../../orpc/middleware/require-permission")
	>("../../../../../orpc/middleware/require-permission");
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	captured.permissionTag = real.PERMISSION_MIDDLEWARE_TAG;
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: unknown) => {
			captured.middlewares.push(mw);
			return chain;
		},
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: real.requireProjectPermission,
		Permissions,
	};
});

import { getWebResearchAvailabilityProcedure } from "../web-research-availability";

type Context = {
	user: { id: string };
	tenantContext: {
		userId: string;
		type: "organization";
		organizationId: string;
	};
	activeOrganizationRole: string | null;
	allowedProjectIds: string[];
	session: { activeOrganizationId: string };
};

type Handler = (args: {
	input: Record<string, unknown>;
	context: Context;
}) => Promise<unknown>;

type Middleware = (
	opts: { context: Context; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

const handler = (
	getWebResearchAvailabilityProcedure as unknown as { _handler: Handler }
)._handler;

const PROJECT_ID = "project-example";
const ORG_ID = "org-example";
const OTHER_ORG_ID = "org-other";
const OWNER_ID = "user-owner";
const CALLER_ID = "user-caller";

function ctx(userId = CALLER_ID): Context {
	return {
		user: { id: userId },
		tenantContext: { userId, type: "organization", organizationId: ORG_ID },
		activeOrganizationRole: null,
		allowedProjectIds: [],
		session: { activeOrganizationId: ORG_ID },
	};
}

/** Run the captured middlewares in order, then the handler, as oRPC would. */
async function callThroughMiddleware(
	input: Record<string, unknown>,
	context: Context = ctx(),
): Promise<unknown> {
	const middlewares = captured.middlewares as Middleware[];
	let output: unknown;
	const run = async (index: number): Promise<unknown> => {
		if (index === middlewares.length) {
			output = await handler({ input, context });
			return { output, context };
		}
		return middlewares[index](
			{ context, next: () => run(index + 1) },
			input,
		);
	};
	await run(0);
	return output;
}

function keyedRow(providerName: string) {
	return {
		providerName,
		enabled: true,
		encryptedApiKey: `encrypted-${providerName}-key`,
	};
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.projectFindUnique.mockResolvedValue({
		id: PROJECT_ID,
		organizationId: ORG_ID,
		userId: OWNER_ID,
	});
	mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([
		keyedRow("firecrawl"),
	]);
});

describe("getWebResearchAvailabilityProcedure — wiring", () => {
	it("is exposed as projects.documents.webResearchAvailability", () => {
		// Read as source: importing the projects router would load every
		// procedure module under this file's mocks.
		const routerSource = readFileSync(
			resolve(__dirname, "../../../router.ts"),
			"utf8",
		);
		const documentsGroup = routerSource.slice(
			routerSource.indexOf("\tdocuments: {"),
		);

		expect(documentsGroup).toContain(
			"webResearchAvailability: getWebResearchAvailabilityProcedure,",
		);
	});

	it("registers exactly one middleware: the project gate at DOCUMENT_READ", () => {
		expect(captured.middlewares).toHaveLength(1);
		const tag = captured.permissionTag as symbol;
		expect((captured.middlewares[0] as Record<symbol, unknown>)[tag]).toBe(
			"document:read",
		);
	});
});

describe("getWebResearchAvailabilityProcedure — the organization", () => {
	it("comes from the project row even when the caller sends another organizationId", async () => {
		const result = await handler({
			input: { projectId: PROJECT_ID, organizationId: OTHER_ORG_ID },
			context: ctx(),
		});

		expect(result).toEqual({ available: true, missing: [] });
		// Loaded by id alone: the middleware already authorized this project.
		expect(mocks.projectFindUnique).toHaveBeenCalledWith({
			where: { id: PROJECT_ID },
			select: { organizationId: true },
		});
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).toHaveBeenCalledTimes(1);
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).toHaveBeenCalledWith(ORG_ID);
	});

	it("answers unavailable, with no provider read, for a project with no organization", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			userId: OWNER_ID,
		});

		const result = await handler({
			input: { projectId: PROJECT_ID },
			context: ctx(),
		});

		expect(result).toEqual({
			available: false,
			missing: ["search", "read"],
		});
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).not.toHaveBeenCalled();
		expect(mocks.getEnabledUserSearchProviders).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for a project row that is gone", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		await expect(
			handler({ input: { projectId: PROJECT_ID }, context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).not.toHaveBeenCalled();
	});

	it("reports what is missing without naming a provider", async () => {
		mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([
			keyedRow("cloudflare"),
		]);

		const result = await handler({
			input: { projectId: PROJECT_ID },
			context: ctx(),
		});

		expect(result).toEqual({ available: false, missing: ["search"] });
	});

	it("never decrypts a provider key", async () => {
		mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([
			keyedRow("exa"),
			keyedRow("jina"),
			keyedRow("cloudflare"),
		]);

		await handler({ input: { projectId: PROJECT_ID }, context: ctx() });

		expect(mocks.getEnabledOrganizationSearchProviders).toHaveBeenCalled();
		expect(mocks.decryptApiKey).not.toHaveBeenCalled();
	});
});

describe("getWebResearchAvailabilityProcedure — authorization", () => {
	it("refuses a caller without project access before any provider read", async () => {
		// No organization membership and no project membership. NOT_FOUND, not
		// FORBIDDEN: a caller with no tie must not learn the project exists.
		mocks.memberFindFirst.mockResolvedValue(null);
		mocks.projectMemberFindUnique.mockResolvedValue(null);

		await expect(
			callThroughMiddleware({ projectId: PROJECT_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).not.toHaveBeenCalled();
		expect(mocks.getEnabledUserSearchProviders).not.toHaveBeenCalled();
	});

	it("answers a project viewer: reading documents is enough", async () => {
		mocks.memberFindFirst.mockResolvedValue(null);
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
			expiresAt: null,
		});

		await expect(
			callThroughMiddleware({ projectId: PROJECT_ID }),
		).resolves.toEqual({ available: true, missing: [] });
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).toHaveBeenCalledWith(ORG_ID);
	});

	it("refuses a caller-named organization other than the project's before any provider read", async () => {
		mocks.memberFindFirst.mockResolvedValue(null);
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
			expiresAt: null,
		});

		await expect(
			callThroughMiddleware({
				projectId: PROJECT_ID,
				organizationId: OTHER_ORG_ID,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).not.toHaveBeenCalled();
	});
});

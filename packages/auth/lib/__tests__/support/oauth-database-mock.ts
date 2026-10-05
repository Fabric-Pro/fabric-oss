/**
 * The slice of `@repo/database` the authorization server touches, held in
 * memory, for the suites that drive Better Auth's real request cycle.
 *
 * `createDatabaseMock` is the factory a test file passes to
 * `vi.mock("@repo/database", ...)`. Loaded by dynamic import from inside that
 * factory, it shares one module instance, and so one `oauthFixtures`, with the
 * test that imports it.
 */

import { vi } from "vitest";

export const ORGANIZATION_ID = "org-example-alpha";

/** The one organization every fixture project is hosted in. */
export const PROJECT_ORGANIZATION_NAME = "Example Alpha";

interface StoredBinding {
	resource: string;
	projectId: string;
	audience: "mcp" | "api";
	expiresAt: number;
}

interface OAuthFixtures {
	/** How many organizations the signed-in person belongs to. */
	organizationCount: number;
	/** The signed-in person's `mustChangePassword`. */
	mustChangePassword: boolean;
	/** The projects the signed-in person may read. */
	readableProjects: Set<string>;
	/** Authorization bindings by `clientId|codeChallenge`. */
	bindings: Map<string, StoredBinding>;
	/** How long a binding written now stays live. */
	bindingTtlMs: number;
}

export const oauthFixtures: OAuthFixtures = {
	organizationCount: 1,
	mustChangePassword: false,
	readableProjects: new Set(),
	bindings: new Map(),
	bindingTtlMs: 15 * 60 * 1000,
};

export function resetOAuthFixtures(): void {
	oauthFixtures.organizationCount = 1;
	oauthFixtures.mustChangePassword = false;
	oauthFixtures.readableProjects = new Set([
		"project-example-one",
		"project-example-two",
	]);
	oauthFixtures.bindings = new Map();
	oauthFixtures.bindingTtlMs = 15 * 60 * 1000;
}

resetOAuthFixtures();

/** The key of `oauthFixtures.bindings` for one authorization. */
export const keyOf = (clientId: string, codeChallenge: string) =>
	`${clientId}|${codeChallenge}`;

export async function createDatabaseMock() {
	const format = await import(
		"../../../../database/prisma/queries/oauth-token-format"
	);
	return {
		...format,
		db: {
			member: {
				count: vi.fn(async () => oauthFixtures.organizationCount),
			},
			user: {
				findUnique: vi.fn(async () => ({
					mustChangePassword: oauthFixtures.mustChangePassword,
				})),
			},
		},
		isOrganizationMember: vi.fn(
			async (_userId: string, organizationId: string) =>
				organizationId === ORGANIZATION_ID,
		),
		resolveUserOrganization: vi.fn(async () => ({
			kind: "resolved",
			organizationId: ORGANIZATION_ID,
		})),
		resolveOAuthProjectGrantTarget: vi.fn(
			async (_userId: string, projectId: string) =>
				oauthFixtures.readableProjects.has(projectId)
					? {
							projectId,
							projectName: `Project ${projectId}`,
							organizationId: ORGANIZATION_ID,
							organizationName: PROJECT_ORGANIZATION_NAME,
						}
					: null,
		),
		recordAudit: vi.fn(),
		saveOAuthAuthorizationResource: vi.fn(
			async (params: {
				clientId: string;
				codeChallenge: string;
				resource: string;
				projectId: string;
				audience: "mcp" | "api";
			}) => {
				const key = keyOf(params.clientId, params.codeChallenge);
				const standing = oauthFixtures.bindings.get(key);
				if (!standing || standing.expiresAt <= Date.now()) {
					oauthFixtures.bindings.set(key, {
						resource: params.resource,
						projectId: params.projectId,
						audience: params.audience,
						expiresAt: Date.now() + oauthFixtures.bindingTtlMs,
					});
				}
				return liveBinding(key, Date.now());
			},
		),
		findLiveOAuthAuthorizationResource: vi.fn(
			async (
				clientId: string,
				codeChallenge: string,
				now: Date = new Date(),
			) => liveBinding(keyOf(clientId, codeChallenge), now.getTime()),
		),
		extendOAuthAuthorizationResource: vi.fn(
			async (clientId: string, codeChallenge: string) => {
				const row = oauthFixtures.bindings.get(
					keyOf(clientId, codeChallenge),
				);
				if (row && row.expiresAt > Date.now()) {
					row.expiresAt = Date.now() + oauthFixtures.bindingTtlMs;
				}
			},
		),
	};
}

function liveBinding(key: string, now: number) {
	const row = oauthFixtures.bindings.get(key);
	return row && row.expiresAt > now
		? {
				resource: row.resource,
				projectId: row.projectId,
				audience: row.audience,
			}
		: null;
}

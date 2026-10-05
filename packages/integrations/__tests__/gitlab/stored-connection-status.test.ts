/**
 * `readStoredGitLabConnectionStatus` is the status `getGitLabConnectionStatus`
 * reports (connected, needs a reconnect, generation) from ONE read and no
 * write: no classification, no refresh. The MCP client cache runs it on every
 * reuse of a cached GitLab client, and reports and dry runs use it where they
 * must not change anything, so both halves matter.
 *
 * The database is the in-memory fake the connection tests use, wrapped to
 * count every delegate call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
} from "./helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("./helpers/gitlab-fake-db").createGitLabFakeDb
	>,
	calls: [] as string[],
}));

/** The fake database, recording `model.operation` for every call. */
function countingDb() {
	const db = state.fake.db as unknown as Record<
		string,
		Record<string, (...args: unknown[]) => unknown>
	>;
	return new Proxy(db, {
		get(target, model: string) {
			const delegate = target[model];
			if (!delegate || typeof delegate !== "object") {
				return delegate;
			}
			return new Proxy(delegate, {
				get(inner, operation: string) {
					const fn = inner[operation];
					if (typeof fn !== "function") {
						return fn;
					}
					return (...args: unknown[]) => {
						state.calls.push(`${model}.${operation}`);
						return fn.apply(inner, args);
					};
				},
			});
		},
	});
}

vi.mock("@repo/database", () => ({
	get db() {
		return countingDb();
	},
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		keys: string | readonly string[],
		fn: (
			tx: unknown,
			assertBudget: (ms: number) => void,
		) => Promise<unknown>,
	) => state.fake.withLock(keys, fn as never),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import("./helpers/gitlab-fake-db");
	return {
		...(await importOriginal<object>()),
		decryptApiKey: helpers.fakeDecrypt,
		encryptApiKey: helpers.fakeEncrypt,
	};
});

import {
	getGitLabConnectionStatus,
	readStoredGitLabConnectionStatus,
	resetGitLabConnectionDepsForTests,
} from "../../src/gitlab/index";

const tenant = { userId: "user-1", organizationId: "org-1" };

function connectionRow(
	credential: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	return {
		id: "wi-1",
		userId: tenant.userId,
		organizationId: tenant.organizationId,
		provider: "GITLAB",
		name: "GitLab: dev",
		workflowId: null,
		credentials: encryptedCredential(credential),
		settings: {},
		isActive: true,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...extra,
	};
}

const issued = {
	access_token: "access",
	refresh_token: "refresh",
	issuer: {
		kind: "integration-app",
		clientId: "app-client",
		origin: "https://gitlab.com",
	},
	connectionGeneration: 3,
};

beforeEach(() => {
	resetGitLabConnectionDepsForTests();
	state.calls.length = 0;
});

describe("readStoredGitLabConnectionStatus", () => {
	it.each([
		["connected", [connectionRow(issued)]],
		[
			"needing a reconnect",
			[
				connectionRow(issued, {
					settings: { needsReauth: true, reauthReason: "revoked" },
				}),
			],
		],
		[
			"disconnected",
			[
				connectionRow(
					{ connectionGeneration: 4, disconnectedAt: "2026-02-01" },
					{ isActive: false },
				),
			],
		],
		["never connected", []],
	])(
		"reports a connection %s as the service's status does, from one read and no write",
		async (_name, workflowIntegration) => {
			state.fake = createGitLabFakeDb({ workflowIntegration });
			const status = await getGitLabConnectionStatus(tenant);
			state.calls.length = 0;

			const stored = await readStoredGitLabConnectionStatus(tenant);

			expect({
				connected: stored.connected,
				needsReauth: stored.needsReauth,
				generation: stored.generation,
			}).toEqual({
				connected: status.connected,
				needsReauth: status.needsReauth,
				generation: status.generation,
			});
			expect(state.calls).toEqual(["workflowIntegration.findMany"]);
		},
	);

	it("leaves a legacy row without an issuer unclassified (no write)", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				connectionRow({ access_token: "access", refresh_token: "r" }),
			],
		});

		const stored = await readStoredGitLabConnectionStatus(tenant);

		expect(stored).toMatchObject({ connected: true, needsReauth: false });
		expect(state.calls).toEqual(["workflowIntegration.findMany"]);
	});
});

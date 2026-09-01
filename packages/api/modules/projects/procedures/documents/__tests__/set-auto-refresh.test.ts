/**
 * Living Documents auto-refresh enrollment — `getDocumentAutoRefreshProcedure`
 * and `setDocumentAutoRefreshProcedure`.
 *
 * Three gates guard both handlers:
 *   1. Feature flag — `await assertLivingDocsRefreshEnabled()` throws NOT_FOUND
 *      when the `LIVING_DOCS_REFRESH` registry flag resolves off, so the API
 *      behaves as if the routes don't exist. The flag resolves override row >
 *      `FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT` > registry default (OFF);
 *      `packages/api/vitest.config.ts` sets the env var to "true", so the suite
 *      runs enabled and stubs it off where it matters. The `isFeatureEnabled`
 *      mock below runs the REAL `resolveFlag`, so both env stubbing and an
 *      admin override are exercised against the shipped precedence rather than
 *      a re-implementation of it.
 *   2. Tenant gate — `getDocumentById` is an UNSCOPED findUnique, so the
 *      document's tenant, not `hasProjectAccess`, is the isolation boundary. A
 *      caller from the wrong tenant must get NOT_FOUND (never FORBIDDEN, which
 *      would confirm the document exists — see
 *      `docs/solutions/architecture-patterns/cancelling-temporal-backed-jobs.md` §3).
 *   3. `requireProjectPermission(DOCUMENT_UPDATE)` — a passthrough in this oRPC
 *      mock harness (its enforcement is covered by
 *      `packages/api/__tests__/require-project-permission.test.ts`), so the
 *      wiring is asserted structurally, the create-test-case harness pattern.
 *
 * oRPC mocks mirror the sibling `update-with-context-phase2.test.ts`.
 */

import {
	type FeatureFlagKey,
	resolveFlag,
} from "@repo/utils/feature-flag-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		hasProjectAccess: vi.fn(),
		getDocumentById: vi.fn(),
		getAutoRefreshSettings: vi.fn(),
		upsertAutoRefreshSettings: vi.fn(),
		isFeatureEnabled: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getDocumentById: mocks.getDocumentById,
	getAutoRefreshSettings: mocks.getAutoRefreshSettings,
	upsertAutoRefreshSettings: mocks.upsertAutoRefreshSettings,
	isFeatureEnabled: mocks.isFeatureEnabled,
	DEFAULT_DOCUMENT_REFRESH_CADENCE: "BIWEEKLY",
}));

vi.mock("../../../../../orpc/procedures", () => {
	let lastPermission: string | undefined;
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: unknown) => {
			const p = (mw as { __permission?: string })?.__permission;
			if (p) {
				lastPermission = p;
			}
			return chain;
		},
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			__permission: lastPermission,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (permission: string) => {
			const mw = () => chain;
			(mw as unknown as { __permission: string }).__permission =
				permission;
			return mw;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { getDocumentAutoRefreshProcedure } from "../get-auto-refresh";
import { setDocumentAutoRefreshProcedure } from "../set-auto-refresh";

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string | null };
	};
}) => Promise<Record<string, unknown>>;

const wired = (p: unknown) =>
	p as unknown as { _handler: Handler; __permission: string };

const getHandler = wired(getDocumentAutoRefreshProcedure)._handler;
const setHandler = wired(setDocumentAutoRefreshProcedure)._handler;

const PROJECT_ID = "project-1";
const DOCUMENT_ID = "doc-1";
const ORG_ID = "org-a";

function ctx(userId = "user-1") {
	return {
		user: { id: userId },
		session: { activeOrganizationId: ORG_ID },
	};
}

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: DOCUMENT_ID,
		projectId: PROJECT_ID,
		title: "PRD",
		type: "PRD",
		userId: "owner-1",
		organizationId: ORG_ID,
		...overrides,
	};
}

function makeSettings(overrides: Record<string, unknown> = {}) {
	return {
		id: "settings-1",
		documentId: DOCUMENT_ID,
		projectId: PROJECT_ID,
		enabled: true,
		cadence: "BIWEEKLY",
		createdByUserId: "user-1",
		lastRefreshedAt: null,
		lastAttemptAt: null,
		lastRefreshStatus: null,
		lastRefreshSummary: null,
		userId: "owner-1",
		organizationId: ORG_ID,
		...overrides,
	};
}

function setInput(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT_ID,
		id: DOCUMENT_ID,
		organizationId: ORG_ID,
		enabled: true,
		...overrides,
	};
}

function getInput(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT_ID,
		id: DOCUMENT_ID,
		organizationId: ORG_ID,
		...overrides,
	};
}

/**
 * The admin override row, as `getFlagOverrides` would report it. `undefined` is
 * "no row" — which is NOT the same as `false`, and the difference is the whole
 * point of the registry: an explicit `false` beats a truthy env var.
 */
let flagOverride: boolean | undefined;

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	flagOverride = undefined;
	mocks.isFeatureEnabled.mockImplementation(
		async (key: FeatureFlagKey) =>
			resolveFlag(key, flagOverride, process.env).enabled,
	);
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getDocumentById.mockResolvedValue(makeDocument());
	mocks.getAutoRefreshSettings.mockResolvedValue(null);
	mocks.upsertAutoRefreshSettings.mockImplementation(
		async (input: Record<string, unknown>) => makeSettings(input),
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getDocumentAutoRefreshProcedure", () => {
	it("reports auto-refresh disabled at the default cadence for a document with no settings row", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(null);

		const result = await getHandler({ input: getInput(), context: ctx() });

		expect(result.enabled).toBe(false);
		expect(result.cadence).toBe("BIWEEKLY");
		expect(result.lastRefreshedAt).toBeNull();
	});

	it("returns the stored enrollment when a row exists", async () => {
		const lastRefreshedAt = new Date("2026-07-01T00:00:00.000Z");
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({
				enabled: true,
				cadence: "MONTHLY",
				lastRefreshedAt,
				lastRefreshStatus: "COMMITTED",
			}),
		);

		const result = await getHandler({ input: getInput(), context: ctx() });

		expect(result).toMatchObject({
			enabled: true,
			cadence: "MONTHLY",
			lastRefreshedAt,
			lastRefreshStatus: "COMMITTED",
		});
	});
});

describe("setDocumentAutoRefreshProcedure — enrollment", () => {
	it("stores BIWEEKLY when enabling with no cadence supplied", async () => {
		const result = await setHandler({
			input: setInput({ enabled: true }),
			context: ctx(),
		});

		expect(mocks.upsertAutoRefreshSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: DOCUMENT_ID,
				projectId: PROJECT_ID,
				enabled: true,
				cadence: "BIWEEKLY",
			}),
		);
		expect(result.cadence).toBe("BIWEEKLY");
	});

	it("keeps the existing cadence when a plain on/off flip supplies none", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({ enabled: false, cadence: "WEEKLY" }),
		);

		await setHandler({
			input: setInput({ enabled: true }),
			context: ctx(),
		});

		expect(mocks.upsertAutoRefreshSettings).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: true, cadence: "WEEKLY" }),
		);
	});

	it("honours an explicitly chosen cadence", async () => {
		await setHandler({
			input: setInput({ enabled: true, cadence: "MONTHLY" }),
			context: ctx(),
		});

		expect(mocks.upsertAutoRefreshSettings).toHaveBeenCalledWith(
			expect.objectContaining({ cadence: "MONTHLY" }),
		);
	});

	it("copies the tenant columns from the parent document, not from the caller", async () => {
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ userId: "owner-9", organizationId: ORG_ID }),
		);

		await setHandler({
			input: setInput({ enabled: true }),
			context: ctx("member-2"),
		});

		expect(mocks.upsertAutoRefreshSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "owner-9",
				organizationId: ORG_ID,
			}),
		);
	});

	it("enrolls a GENERAL-type document — enrollment is not gated on document type", async () => {
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ type: "GENERAL" }),
		);

		const result = await setHandler({
			input: setInput({ enabled: true }),
			context: ctx(),
		});

		expect(result.enabled).toBe(true);
		expect(mocks.upsertAutoRefreshSettings).toHaveBeenCalledTimes(1);
	});
});

describe("setDocumentAutoRefreshProcedure — actor re-homing", () => {
	it("stamps createdByUserId with the caller", async () => {
		await setHandler({
			input: setInput({ enabled: true }),
			context: ctx("user-1"),
		});

		expect(mocks.upsertAutoRefreshSettings).toHaveBeenCalledWith(
			expect.objectContaining({ createdByUserId: "user-1" }),
		);
	});

	it("re-homes createdByUserId to a second member who re-enables", async () => {
		await setHandler({
			input: setInput({ enabled: true }),
			context: ctx("user-1"),
		});

		// The row now exists, owned by user-1.
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({ enabled: false, createdByUserId: "user-1" }),
		);

		await setHandler({
			input: setInput({ enabled: true }),
			context: ctx("user-2"),
		});

		expect(mocks.upsertAutoRefreshSettings).toHaveBeenLastCalledWith(
			expect.objectContaining({
				createdByUserId: "user-2",
				enabled: true,
			}),
		);
	});
});

describe("setDocumentAutoRefreshProcedure — unenrollment", () => {
	it("keeps the row and preserves lastRefreshedAt when disabling", async () => {
		const lastRefreshedAt = new Date("2026-07-01T00:00:00.000Z");
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({ enabled: true, cadence: "WEEKLY", lastRefreshedAt }),
		);
		mocks.upsertAutoRefreshSettings.mockResolvedValue(
			makeSettings({
				enabled: false,
				cadence: "WEEKLY",
				lastRefreshedAt,
			}),
		);

		const result = await setHandler({
			input: setInput({ enabled: false }),
			context: ctx(),
		});

		const payload = mocks.upsertAutoRefreshSettings.mock
			.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.enabled).toBe(false);
		expect(payload.cadence).toBe("WEEKLY");
		// The cycle clock is never written from the enrollment path — disabling and
		// re-enabling must not reset (or backdate) it.
		expect(payload).not.toHaveProperty("lastRefreshedAt");
		expect(result.enabled).toBe(false);
		expect(result.lastRefreshedAt).toEqual(lastRefreshedAt);
	});
});

describe("auto-refresh enrollment — authorization", () => {
	it("wires both procedures to the DOCUMENT_UPDATE permission", () => {
		expect(wired(getDocumentAutoRefreshProcedure).__permission).toBe(
			"DOCUMENT_UPDATE",
		);
		expect(wired(setDocumentAutoRefreshProcedure).__permission).toBe(
			"DOCUMENT_UPDATE",
		);
	});

	it("rejects a caller without project access with FORBIDDEN", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			setHandler({ input: setInput(), context: ctx() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.upsertAutoRefreshSettings).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND when the document is not in the given project", async () => {
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ projectId: "other-project" }),
		);

		await expect(
			setHandler({ input: setInput(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.upsertAutoRefreshSettings).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND — never FORBIDDEN — for a caller in the wrong tenant", async () => {
		// The document lives in org-a; the caller resolves to org-b. Project access
		// is deliberately mocked TRUE so the assertion can only pass if the tenant
		// gate ran BEFORE the access check, and answered NOT_FOUND.
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ organizationId: "org-a" }),
		);
		mocks.hasProjectAccess.mockResolvedValue(true);

		for (const handler of [getHandler, setHandler]) {
			const error = await handler({
				input: setInput({ organizationId: "org-b" }),
				context: ctx(),
			}).catch((e: { code: string }) => e);

			expect(error).toMatchObject({ code: "NOT_FOUND" });
			expect(error).not.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.upsertAutoRefreshSettings).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND for a personal-context caller reaching an org document", async () => {
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ organizationId: ORG_ID }),
		);

		await expect(
			setHandler({
				input: setInput({ organizationId: null }),
				context: ctx(),
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.upsertAutoRefreshSettings).not.toHaveBeenCalled();
	});
});

describe("auto-refresh enrollment — feature flag", () => {
	it("throws NOT_FOUND from both procedures when the env var is off, without touching the DB", async () => {
		vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT", "false");

		await expect(
			getHandler({ input: getInput(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			setHandler({ input: setInput(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.getDocumentById).not.toHaveBeenCalled();
		expect(mocks.getAutoRefreshSettings).not.toHaveBeenCalled();
		expect(mocks.upsertAutoRefreshSettings).not.toHaveBeenCalled();
	});

	it("resolves the gate through the shared registry, by key", async () => {
		await setHandler({ input: setInput(), context: ctx() });

		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"LIVING_DOCS_REFRESH",
		);
	});

	it("lets an admin override of false close the routes even with the env var set", async () => {
		// The env var says on — vitest.config.ts sets it for the whole suite —
		// and the override still wins. This is the runtime kill switch the
		// bespoke env-var helper could never provide.
		vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT", "true");
		flagOverride = false;

		await expect(
			getHandler({ input: getInput(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			setHandler({ input: setInput(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.getDocumentById).not.toHaveBeenCalled();
		expect(mocks.upsertAutoRefreshSettings).not.toHaveBeenCalled();
	});
});

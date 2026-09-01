/**
 * Living Documents auto-refresh — the READ half, `getDocumentAutoRefreshProcedure`.
 *
 * This is the procedure the masthead control calls on every document open, and
 * after Fizzy #2210 it is the ONLY thing that decides whether that control
 * renders: the client no longer consults a build-time
 * `NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH` twin. So the two behaviours
 * pinned here are load-bearing in a way they were not before —
 *
 *   - WITH THE CAPABILITY OFF, THE READ 404s BEFORE IT TOUCHES THE DATABASE.
 *     The client reads NOT_FOUND as "this capability does not exist here" and
 *     renders nothing. Reaching a query first would make an off flag cost a
 *     round-trip per document open, and a gate that runs after its side effects
 *     is not a gate.
 *   - WITH IT ON, THE STORED ROW COMES BACK VERBATIM. A read that quietly
 *     answered with defaults would be indistinguishable from a failed read —
 *     which is the exact confusion the ticket was filed about (the control
 *     rendered against its own fallbacks and every click then failed).
 *
 * The flag resolves through the shared registry: override row >
 * `FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT` > registry default (OFF). The
 * `isFeatureEnabled` mock below runs the REAL `resolveFlag`, so precedence is
 * exercised as shipped rather than re-implemented here.
 *
 * oRPC and tenant mocks mirror the sibling `set-auto-refresh.test.ts`.
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
		isFeatureEnabled: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getDocumentById: mocks.getDocumentById,
	getAutoRefreshSettings: mocks.getAutoRefreshSettings,
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

const PROJECT_ID = "project-1";
const DOCUMENT_ID = "doc-1";
const ORG_ID = "org-a";
const PROPOSED_AT = new Date("2026-07-01T00:00:00.000Z");

function ctx(userId = "user-1") {
	return {
		user: { id: userId },
		session: { activeOrganizationId: ORG_ID },
	};
}

function input(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT_ID,
		id: DOCUMENT_ID,
		organizationId: ORG_ID,
		...overrides,
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
		cadence: "WEEKLY",
		autoApply: false,
		createdByUserId: "user-1",
		lastRefreshedAt: null,
		lastAttemptAt: null,
		lastRefreshStatus: null,
		lastRefreshSummary: null,
		pendingContent: null,
		pendingSummary: null,
		pendingProposedAt: null,
		pendingBaselineVersion: null,
		userId: "owner-1",
		organizationId: ORG_ID,
		...overrides,
	};
}

/** The admin override row, as `getFlagOverrides` would report it. */
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
	mocks.getAutoRefreshSettings.mockResolvedValue(makeSettings());
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getDocumentAutoRefreshProcedure — capability off", () => {
	it("rejects with NOT_FOUND before any database access when the env var is off", async () => {
		vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT", "false");

		await expect(
			getHandler({ input: input(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.getDocumentById).not.toHaveBeenCalled();
		expect(mocks.getAutoRefreshSettings).not.toHaveBeenCalled();
		expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
	});

	it("rejects with NOT_FOUND when an admin override closes it, even with the env var set", async () => {
		// The runtime kill switch the bespoke env-var helper could never
		// provide: the override beats a truthy env var, with no redeploy.
		vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT", "true");
		flagOverride = false;

		await expect(
			getHandler({ input: input(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.getDocumentById).not.toHaveBeenCalled();
		expect(mocks.getAutoRefreshSettings).not.toHaveBeenCalled();
	});

	it("resolves the gate through the shared registry, by key", async () => {
		await getHandler({ input: input(), context: ctx() });

		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"LIVING_DOCS_REFRESH",
		);
	});
});

describe("getDocumentAutoRefreshProcedure — capability on", () => {
	it("returns the stored enrollment", async () => {
		const lastRefreshedAt = new Date("2026-07-08T00:00:00.000Z");
		const lastAttemptAt = new Date("2026-07-09T00:00:00.000Z");
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({
				enabled: true,
				cadence: "MONTHLY",
				autoApply: true,
				lastRefreshedAt,
				lastAttemptAt,
				lastRefreshStatus: "COMMITTED",
				lastRefreshSummary: "Trimmed the rollout section.",
			}),
		);

		const result = await getHandler({ input: input(), context: ctx() });

		expect(result).toMatchObject({
			enabled: true,
			cadence: "MONTHLY",
			autoApply: true,
			lastRefreshedAt,
			lastAttemptAt,
			lastRefreshStatus: "COMMITTED",
			lastRefreshSummary: "Trimmed the rollout section.",
		});
	});

	it("reports opted-out defaults for a document with no settings row", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(null);

		const result = await getHandler({ input: input(), context: ctx() });

		expect(result).toMatchObject({
			enabled: false,
			cadence: "BIWEEKLY",
			autoApply: false,
			pending: null,
		});
	});

	it("returns a pending proposal only when there is content behind it", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({
				pendingContent: "# PRD\n\nRefreshed body.",
				pendingSummary: "Removed SSO from scope.",
				pendingProposedAt: PROPOSED_AT,
				pendingBaselineVersion: 4,
			}),
		);

		const result = await getHandler({ input: input(), context: ctx() });

		expect(result.pending).toEqual({
			content: "# PRD\n\nRefreshed body.",
			summary: "Removed SSO from scope.",
			proposedAt: PROPOSED_AT,
			baselineVersion: 4,
		});
	});

	it("reports no pending proposal when only the summary columns survive", async () => {
		// `pendingContent` is the authority. A summary with nothing behind it
		// must not render as a reviewable proposal.
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({
				pendingContent: null,
				pendingSummary: "Removed SSO from scope.",
				pendingProposedAt: PROPOSED_AT,
			}),
		);

		const result = await getHandler({ input: input(), context: ctx() });

		expect(result.pending).toBeNull();
	});
});

describe("getDocumentAutoRefreshProcedure — authorization", () => {
	it("is wired to the DOCUMENT_UPDATE permission — the read half of a write control", () => {
		expect(wired(getDocumentAutoRefreshProcedure).__permission).toBe(
			"DOCUMENT_UPDATE",
		);
	});

	it("returns NOT_FOUND — never FORBIDDEN — for a caller in the wrong tenant", async () => {
		// Project access is mocked TRUE on purpose: this can only pass if the
		// tenant gate ran first. A FORBIDDEN would confirm the document exists.
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ organizationId: "org-a" }),
		);

		const error = await getHandler({
			input: input({ organizationId: "org-b" }),
			context: ctx(),
		}).catch((e: { code: string }) => e);

		expect(error).toMatchObject({ code: "NOT_FOUND" });
		expect(error).not.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getAutoRefreshSettings).not.toHaveBeenCalled();
	});

	it("rejects a caller without project access with FORBIDDEN", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			getHandler({ input: input(), context: ctx() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getAutoRefreshSettings).not.toHaveBeenCalled();
	});
});

/**
 * Handler-direct tests for admin.featureFlags.listForOrg / setForOrg /
 * clearForOrg.
 *
 * Same mocking + invocation pattern as the sibling `feature-flags.test.ts`:
 * spread-the-actual `@repo/database` mock so the procedure builder's
 * transitive deps keep working, and `procedure["~orpc"].handler(...)` to
 * invoke directly, bypassing the oRPC middleware chain.
 */
import {
	FEATURE_FLAG_KEYS,
	type FeatureFlagKey,
	isOrgScopableFlag,
	ORG_SCOPABLE_FLAG_KEYS,
} from "@repo/utils/feature-flag-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOrgScopableFlagsDetailed: vi.fn(),
	getOrgFlagStateUncached: vi.fn(),
	setOrgFlagOverride: vi.fn(),
	clearOrgFlagOverride: vi.fn(),
	getOrganizationById: vi.fn(),
	recordAuditDurable: vi.fn(),
	markCuratedAuditWritten: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getOrgScopableFlagsDetailed: mocks.getOrgScopableFlagsDetailed,
		getOrgFlagStateUncached: mocks.getOrgFlagStateUncached,
		setOrgFlagOverride: mocks.setOrgFlagOverride,
		clearOrgFlagOverride: mocks.clearOrgFlagOverride,
		getOrganizationById: mocks.getOrganizationById,
		recordAuditDurable: mocks.recordAuditDurable,
	};
});

// `markCuratedAuditWritten` is a no-op outside an AsyncLocalStorage frame, so
// the real one would not throw here — it is mocked to make the CALL assertable,
// since forgetting it produces a duplicate audit row and nothing else
// observable. PARTIAL rather than a full replacement: `orpc/procedures.ts`
// pulls `auditTimingMiddleware` from this same module while building the
// procedure chain, so stubbing the module wholesale breaks the import of the
// file under test.
vi.mock(
	"../../../../orpc/middleware/audit-timing-middleware",
	async (importOriginal) => {
		const actual = (await importOriginal()) as Record<string, unknown>;
		return {
			...actual,
			markCuratedAuditWritten: mocks.markCuratedAuditWritten,
		};
	},
);

// `protectedProcedure` imports lazily from `@repo/payments` only on the catch
// path of the AI-usage-limit error mapper, but the procedures module
// re-exports its types eagerly. Stub the package so module load doesn't blow
// up (mirrors list-users.test.ts).
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import {
	clearOrgFeatureFlagProcedure,
	listOrgFeatureFlagsProcedure,
	setOrgFeatureFlagProcedure,
} from "../org-feature-flags";

const admin = { id: "user_admin", role: "admin" };
const ORG_ID = "org_test";

/**
 * A concrete org-scopable key, taken from the registry rather than written
 * literally so this file does not pin which flag happens to carry the marker.
 */
const SCOPABLE_KEY: FeatureFlagKey = ORG_SCOPABLE_FLAG_KEYS[0];

/**
 * A key the resolver ignores at the org level — the input the write path must
 * refuse. Also derived, for the same reason.
 */
const NON_SCOPABLE_KEY: FeatureFlagKey = FEATURE_FLAG_KEYS.find(
	(key) => !isOrgScopableFlag(key),
) as FeatureFlagKey;

function callHandler(procedure: unknown, input: unknown, user = admin) {
	return (
		procedure as {
			"~orpc": {
				handler: (a: {
					input: unknown;
					context: unknown;
					errors: unknown;
				}) => Promise<unknown>;
			};
		}
	)["~orpc"].handler({ input, context: { user }, errors: {} });
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		key: SCOPABLE_KEY,
		enabled: false,
		source: "default",
		orgOverride: undefined,
		...overrides,
	};
}

/** The single-flag shape `getOrgFlagStateUncached` returns. */
function state(overrides: Record<string, unknown> = {}) {
	return {
		enabled: false,
		source: "default",
		orgOverride: undefined,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getOrganizationById.mockResolvedValue({ id: ORG_ID });
});

describe("registry preconditions", () => {
	// Guards the two constants above. Without this, a registry where every
	// flag became org-scopable would leave `NON_SCOPABLE_KEY` undefined and
	// the refusal tests below would assert against a malformed input instead
	// of the case they name.
	it("supplies both a scopable and a non-scopable key", () => {
		expect(SCOPABLE_KEY).toBeDefined();
		expect(isOrgScopableFlag(SCOPABLE_KEY)).toBe(true);
		expect(NON_SCOPABLE_KEY).toBeDefined();
		expect(isOrgScopableFlag(NON_SCOPABLE_KEY)).toBe(false);
	});
});

describe("admin.featureFlags.listForOrg", () => {
	it("joins registry metadata onto the organization's resolved values", async () => {
		mocks.getOrgScopableFlagsDetailed.mockResolvedValue([
			row({ enabled: true, source: "org-override", orgOverride: true }),
		]);

		const result = (await callHandler(listOrgFeatureFlagsProcedure, {
			organizationId: ORG_ID,
		})) as { flags: Array<Record<string, unknown>> };

		expect(result.flags).toHaveLength(1);
		expect(result.flags[0]).toMatchObject({
			key: SCOPABLE_KEY,
			enabled: true,
			source: "org-override",
			orgOverride: true,
		});
		// Registry metadata rides along so the panel can render label/note
		// without a second round trip.
		expect(result.flags[0].label).toEqual(expect.any(String));
		expect(result.flags[0].envVar).toEqual(expect.any(String));
	});

	it("sends an absent row to the wire as null, not undefined", async () => {
		mocks.getOrgScopableFlagsDetailed.mockResolvedValue([
			row({ orgOverride: undefined }),
		]);

		const result = (await callHandler(listOrgFeatureFlagsProcedure, {
			organizationId: ORG_ID,
		})) as { flags: Array<Record<string, unknown>> };

		// `undefined` would be dropped by JSON serialization, collapsing
		// "inherit" into "absent field" and making the control's third
		// position unreachable in the client.
		expect(result.flags[0].orgOverride).toBeNull();
	});

	it("404s an organization that does not resolve", async () => {
		mocks.getOrganizationById.mockResolvedValue(null);

		await expect(
			callHandler(listOrgFeatureFlagsProcedure, {
				organizationId: "org_missing",
			}),
		).rejects.toThrow();

		expect(mocks.getOrgScopableFlagsDetailed).not.toHaveBeenCalled();
	});
});

describe("admin.featureFlags.setForOrg", () => {
	it("rejects a key that is not in the registry, without writing", async () => {
		await expect(
			callHandler(setOrgFeatureFlagProcedure, {
				organizationId: ORG_ID,
				key: "NOT_A_REAL_FLAG",
				enabled: true,
			}),
		).rejects.toThrow(/Unknown feature flag/);

		expect(mocks.setOrgFlagOverride).not.toHaveBeenCalled();
	});

	it("rejects a registered key that is not organization-scopable, without writing", async () => {
		await expect(
			callHandler(setOrgFeatureFlagProcedure, {
				organizationId: ORG_ID,
				key: NON_SCOPABLE_KEY,
				enabled: true,
			}),
		).rejects.toThrow(/not organization-scopable/);

		// The row would be inert — `resolveFlag` ignores an org-level value
		// for such a flag — so it must never be created at all. A stored row
		// nothing reads is a switch that lies to the next operator.
		expect(mocks.setOrgFlagOverride).not.toHaveBeenCalled();
		expect(mocks.recordAuditDurable).not.toHaveBeenCalled();
	});

	it("404s an unknown organization, without writing", async () => {
		mocks.getOrganizationById.mockResolvedValue(null);

		await expect(
			callHandler(setOrgFeatureFlagProcedure, {
				organizationId: "org_missing",
				key: SCOPABLE_KEY,
				enabled: true,
			}),
		).rejects.toThrow();

		expect(mocks.setOrgFlagOverride).not.toHaveBeenCalled();
	});

	it("writes an org-scopable key and returns the re-resolved state", async () => {
		mocks.getOrgFlagStateUncached
			.mockResolvedValueOnce(state({ enabled: false, source: "default" }))
			.mockResolvedValueOnce(
				state({
					enabled: true,
					source: "org-override",
					orgOverride: true,
				}),
			);

		const result = await callHandler(setOrgFeatureFlagProcedure, {
			organizationId: ORG_ID,
			key: SCOPABLE_KEY,
			enabled: true,
		});

		expect(mocks.setOrgFlagOverride).toHaveBeenCalledWith({
			key: SCOPABLE_KEY,
			organizationId: ORG_ID,
			enabled: true,
			updatedBy: admin.id,
		});
		// Taken from the read AFTER the write, not echoed from the input: the
		// panel patches its cache from this instead of refetching.
		expect(result).toEqual({
			success: true,
			enabled: true,
			source: "org-override",
			orgOverride: true,
		});
	});

	it("resolves the response uncached, never through the cached reader", async () => {
		mocks.getOrgFlagStateUncached.mockResolvedValue(
			state({ enabled: true, source: "org-override", orgOverride: true }),
		);

		await callHandler(setOrgFeatureFlagProcedure, {
			organizationId: ORG_ID,
			key: SCOPABLE_KEY,
			enabled: true,
		});

		// The panel patches its cache from this response and never refetches,
		// so it is the only thing that corrects the UI. A cached read could
		// return an org entry refilled by a fetch that started before the
		// eviction, or a global entry an org write never evicts at all.
		expect(mocks.getOrgFlagStateUncached).toHaveBeenCalledTimes(2);
		expect(mocks.getOrgScopableFlagsDetailed).not.toHaveBeenCalled();
	});

	it("marks the curated audit row so the middleware adds no duplicate", async () => {
		mocks.getOrgFlagStateUncached.mockResolvedValue(state());

		await callHandler(setOrgFeatureFlagProcedure, {
			organizationId: ORG_ID,
			key: SCOPABLE_KEY,
			enabled: true,
		});

		expect(mocks.markCuratedAuditWritten).toHaveBeenCalledTimes(1);
	});

	it("does not mark a curated row when the write was refused", async () => {
		await expect(
			callHandler(setOrgFeatureFlagProcedure, {
				organizationId: ORG_ID,
				key: NON_SCOPABLE_KEY,
				enabled: true,
			}),
		).rejects.toThrow();

		// Precondition for the assertion above being meaningful: a refusal
		// must leave the middleware free to record the attempt.
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it("stores an explicit false rather than clearing the row", async () => {
		mocks.getOrgFlagStateUncached
			.mockResolvedValueOnce(state({ enabled: true, source: "env" }))
			.mockResolvedValueOnce(
				state({
					enabled: false,
					source: "org-override",
					orgOverride: false,
				}),
			);

		const result = await callHandler(setOrgFeatureFlagProcedure, {
			organizationId: ORG_ID,
			key: SCOPABLE_KEY,
			enabled: false,
		});

		expect(mocks.clearOrgFlagOverride).not.toHaveBeenCalled();
		expect(mocks.setOrgFlagOverride).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false }),
		);
		expect(result).toMatchObject({ orgOverride: false, enabled: false });
	});

	it("audits the change against the organization it applied to", async () => {
		mocks.getOrgFlagStateUncached
			.mockResolvedValueOnce(state({ enabled: false, source: "default" }))
			.mockResolvedValueOnce(
				state({
					enabled: true,
					source: "org-override",
					orgOverride: true,
				}),
			);

		await callHandler(setOrgFeatureFlagProcedure, {
			organizationId: ORG_ID,
			key: SCOPABLE_KEY,
			enabled: true,
		});

		const call = mocks.recordAuditDurable.mock.calls[0][0];
		expect(call).toMatchObject({
			action: "featureFlag.orgUpdated",
			severity: "warning",
			actor: { type: "user", userId: admin.id },
			resource: { type: "featureFlag", id: SCOPABLE_KEY },
			metadata: expect.objectContaining({
				previousValue: false,
				previousSource: "default",
				newValue: true,
				newSource: "org-override",
			}),
		});
		// TOP-LEVEL, not merely in metadata. The organization audit log filters
		// strictly on this column, so a metadata-only reference would hide the
		// change from the tenant whose features it altered.
		expect(call.organizationId).toBe(ORG_ID);
	});
});

describe("admin.featureFlags.clearForOrg", () => {
	it("rejects a non-scopable key, without deleting", async () => {
		await expect(
			callHandler(clearOrgFeatureFlagProcedure, {
				organizationId: ORG_ID,
				key: NON_SCOPABLE_KEY,
			}),
		).rejects.toThrow(/not organization-scopable/);

		expect(mocks.clearOrgFlagOverride).not.toHaveBeenCalled();
	});

	it("deletes the row and reports the value the organization now inherits", async () => {
		mocks.getOrgFlagStateUncached
			.mockResolvedValueOnce(
				state({
					enabled: false,
					source: "org-override",
					orgOverride: false,
				}),
			)
			.mockResolvedValueOnce(state({ enabled: true, source: "env" }));

		const result = await callHandler(clearOrgFeatureFlagProcedure, {
			organizationId: ORG_ID,
			key: SCOPABLE_KEY,
		});

		expect(mocks.clearOrgFlagOverride).toHaveBeenCalledWith({
			key: SCOPABLE_KEY,
			organizationId: ORG_ID,
		});
		// The post-clear source cannot be predicted from the input — it falls
		// to override/env/default depending on state only the server sees —
		// so the handler must report what it re-read, not a constant.
		expect(result).toEqual({
			success: true,
			enabled: true,
			source: "env",
			orgOverride: null,
		});
	});

	it("audits the clear as a distinct action", async () => {
		mocks.getOrgFlagStateUncached
			.mockResolvedValueOnce(
				state({
					enabled: true,
					source: "org-override",
					orgOverride: true,
				}),
			)
			.mockResolvedValueOnce(
				state({ enabled: false, source: "default" }),
			);

		await callHandler(clearOrgFeatureFlagProcedure, {
			organizationId: ORG_ID,
			key: SCOPABLE_KEY,
		});

		expect(mocks.recordAuditDurable).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "featureFlag.orgReset",
				organizationId: ORG_ID,
				metadata: expect.objectContaining({
					previousOrgOverride: true,
					newSource: "default",
				}),
			}),
		);
		expect(mocks.markCuratedAuditWritten).toHaveBeenCalledTimes(1);
	});
});

/**
 * The organization Brand kit procedures (Fizzy #2589, R31, KTD2, KTD20).
 *
 * The permission middleware here is the REAL `requireInputOrgPermission`,
 * evaluated against the organization in the input (not the session's), so a
 * member-role FORBIDDEN and a cross-organization FORBIDDEN are the gate's own
 * answers. The handler then narrows to admins and owners and reads the
 * rollout gate for that same organization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, BrandKitValidationError } = vi.hoisted(() => {
	class BrandKitValidationError extends Error {
		constructor(readonly code: string) {
			super(`Invalid Brand kit: ${code}`);
			this.name = "BrandKitValidationError";
		}
	}
	return {
		BrandKitValidationError,
		mocks: {
			getOrganizationMembership: vi.fn(),
			isFeatureEnabled: vi.fn(),
			getBrandKit: vi.fn(),
			upsertBrandKit: vi.fn(),
			updateOrganizationBrandColor: vi.fn(),
			organizationUpdate: vi.fn(),
			recordAudit: vi.fn(),
		},
	};
});

vi.mock("@repo/database", () => ({
	db: {
		organization: { update: mocks.organizationUpdate },
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	grantProjectAccess: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
	getOrganizationMembership: mocks.getOrganizationMembership,
	isFeatureEnabled: mocks.isFeatureEnabled,
	resolveProjectTenant: vi.fn(),
	getBrandKit: mocks.getBrandKit,
	upsertBrandKit: mocks.upsertBrandKit,
	updateOrganizationBrandColor: mocks.updateOrganizationBrandColor,
	BrandKitValidationError,
	BRAND_KIT_MAX_ACCENTS: 3,
	BRAND_KIT_MAX_GUIDANCE_LENGTH: 2000,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", async () => {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const { requireInputOrgPermission } = await vi.importActual<
		typeof import("../../../../../orpc/middleware/require-permission")
	>("../../../../../orpc/middleware/require-permission");
	const state: { middleware?: unknown; input?: unknown } = {};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: unknown) => {
			state.middleware = mw;
			return chain;
		},
		route: () => chain,
		input: (schema: unknown) => {
			state.input = schema;
			return chain;
		},
		output: () => chain,
		handler: (fn: unknown) => ({
			__handler: fn,
			__middleware: state.middleware,
			__input: state.input,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireInputOrgPermission,
		Permissions,
	};
});

import { getBrandKitProcedure } from "../get-brand-kit";
import { updateBrandKitProcedure } from "../update-brand-kit";

const ORG = "org_1";
const OTHER_ORG = "org_2";

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
	}) => Promise<Record<string, unknown>>;
	__middleware: (
		args: { context: unknown; next: () => Promise<unknown> },
		input: unknown,
	) => Promise<unknown>;
	__input: {
		parse: (value: unknown) => Record<string, unknown>;
		safeParse: (value: unknown) => { success: boolean };
	};
};

/** Role of each user in each organization. */
const roles = new Map<string, string>();

function context(userId: string) {
	return {
		user: { id: userId, name: "Admin", email: `${userId}@example.com` },
		session: { id: "session-1", activeOrganizationId: ORG },
		tenantContext: { userId, type: "organization", organizationId: ORG },
	};
}

/** Input validation, the real permission middleware, then the handler. */
async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId: string,
): Promise<Record<string, unknown>> {
	const wired = procedure as Wired;
	const input = wired.__input.parse(rawInput);
	let output: Record<string, unknown> | undefined;
	await wired.__middleware(
		{
			context: context(userId),
			next: async () => {
				output = await wired.__handler({
					input,
					context: context(userId),
				});
				return { output };
			},
		},
		input,
	);
	return output as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
	throw new Error("expected a rejection");
}

function update(userId: string, overrides: Record<string, unknown> = {}) {
	return call(
		updateBrandKitProcedure,
		{
			organizationId: ORG,
			accentColors: ["#0A66C2", "#ff8800"],
			guidance: "Confident, plain, no exclamation marks.",
			...overrides,
		},
		userId,
	);
}

const SAVED_AT = new Date("2026-09-24T10:00:00Z");

beforeEach(() => {
	vi.clearAllMocks();
	roles.clear();
	roles.set(`${ORG}:user_owner`, "owner");
	roles.set(`${ORG}:user_admin`, "admin");
	roles.set(`${ORG}:user_member`, "member");
	roles.set(`${ORG}:user_viewer`, "viewer");
	roles.set(`${OTHER_ORG}:user_other_admin`, "admin");
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string, userId: string) => {
			const role = roles.get(`${organizationId}:${userId}`);
			return role ? { role, organization: { id: organizationId } } : null;
		},
	);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.upsertBrandKit.mockImplementation(async (input) => ({
		brandKit: {
			organizationId: input.organizationId,
			accentColors: input.accentColors.map((c: string) =>
				c.toLowerCase(),
			),
			guidance: input.guidance,
			updatedById: input.updatedById,
			updatedAt: SAVED_AT,
		},
		changedFields: ["accentColors", "guidance"],
	}));
});

describe("updateBrandKitProcedure", () => {
	it("a member-role update is FORBIDDEN and writes nothing", async () => {
		expect(await rejection(update("user_member"))).toBe("FORBIDDEN");
		expect(await rejection(update("user_viewer"))).toBe("FORBIDDEN");
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("an admin of another organization is FORBIDDEN", async () => {
		expect(await rejection(update("user_other_admin"))).toBe("FORBIDDEN");
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ORG,
			"user_other_admin",
		);
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});

	it("an admin update saves the kit and emits exactly one audit event, field names only", async () => {
		const result = await update("user_admin");

		expect(mocks.upsertBrandKit).toHaveBeenCalledWith({
			organizationId: ORG,
			accentColors: ["#0A66C2", "#ff8800"],
			guidance: "Confident, plain, no exclamation marks.",
			updatedById: "user_admin",
		});
		expect(result).toEqual({
			brandKit: {
				accentColors: ["#0a66c2", "#ff8800"],
				guidance: "Confident, plain, no exclamation marks.",
				updatedAt: SAVED_AT,
			},
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(expect.anything(), {
			action: "org.brand_kit.updated",
			category: "org",
			organizationId: ORG,
			resource: { type: "organization", id: ORG, name: null },
			metadata: { changedFields: ["accentColors", "guidance"] },
		});
		// Nothing of the guidance text or the colors reaches the audit row.
		expect(
			JSON.stringify(mocks.recordAudit.mock.calls[0]?.[1]),
		).not.toMatch(/Confident|#0a66c2|#ff8800/i);
	});

	it("leaves the organization's brand color untouched", async () => {
		await update("user_owner");

		expect(mocks.updateOrganizationBrandColor).not.toHaveBeenCalled();
		expect(mocks.organizationUpdate).not.toHaveBeenCalled();
		expect(mocks.upsertBrandKit.mock.calls[0]?.[0]).not.toHaveProperty(
			"brandColor",
		);
	});

	it("with the rollout gate off an admin gets NOT_FOUND and nothing is written", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		expect(await rejection(update("user_admin"))).toBe("NOT_FOUND");
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			ORG,
		);
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});

	it("an organization id of null is refused before any role check can be skipped", async () => {
		const wired = updateBrandKitProcedure as unknown as Wired;
		expect(
			wired.__input.safeParse({
				organizationId: null,
				accentColors: [],
				guidance: null,
			}).success,
		).toBe(false);
	});

	it("refuses too many accents, a non-hex accent and over-long guidance at the input", () => {
		const schema = (updateBrandKitProcedure as unknown as Wired).__input;
		const base = { organizationId: ORG, accentColors: [], guidance: null };
		expect(schema.safeParse(base).success).toBe(true);
		expect(
			schema.safeParse({
				...base,
				accentColors: ["#111111", "#222222", "#333333", "#444444"],
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, accentColors: ["red"] }).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, guidance: "x".repeat(2001) }).success,
		).toBe(false);
	});

	it("a query validation failure is a BAD_REQUEST with its code", async () => {
		mocks.upsertBrandKit.mockRejectedValueOnce(
			new BrandKitValidationError("guidanceTooLong"),
		);

		let caught: unknown;
		try {
			await update("user_admin");
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "guidanceTooLong" },
		});
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});

describe("getBrandKitProcedure", () => {
	it("any member reads the kit, with defaults before it is first saved", async () => {
		mocks.getBrandKit.mockResolvedValueOnce(null);

		await expect(
			call(getBrandKitProcedure, { organizationId: ORG }, "user_viewer"),
		).resolves.toEqual({
			brandKit: { accentColors: [], guidance: null, updatedAt: null },
		});
		expect(mocks.getBrandKit).toHaveBeenCalledWith(ORG);
	});

	it("returns the saved kit", async () => {
		mocks.getBrandKit.mockResolvedValueOnce({
			organizationId: ORG,
			accentColors: ["#0a66c2"],
			guidance: "Plain.",
			updatedById: "user_admin",
			updatedAt: SAVED_AT,
		});

		await expect(
			call(getBrandKitProcedure, { organizationId: ORG }, "user_member"),
		).resolves.toEqual({
			brandKit: {
				accentColors: ["#0a66c2"],
				guidance: "Plain.",
				updatedAt: SAVED_AT,
			},
		});
	});

	it("a non-member is FORBIDDEN; with the gate off a member gets NOT_FOUND", async () => {
		expect(
			await rejection(
				call(
					getBrandKitProcedure,
					{ organizationId: ORG },
					"user_other_admin",
				),
			),
		).toBe("FORBIDDEN");

		mocks.isFeatureEnabled.mockResolvedValue(false);
		expect(
			await rejection(
				call(
					getBrandKitProcedure,
					{ organizationId: ORG },
					"user_member",
				),
			),
		).toBe("NOT_FOUND");
		expect(mocks.getBrandKit).not.toHaveBeenCalled();
	});
});

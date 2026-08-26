/**
 * Organization-level attachment retention setting (Fizzy #1749).
 *
 * Projects inherit this window unless they set their own, so it is an
 * admin/owner-only write: shortening it permanently deletes hidden attachments
 * across every inheriting project once the 7-day grace floor elapses, and there
 * is no restore surface. The `requirePermission(ORG_UPDATE)` middleware is the
 * outer gate; the handler re-checks admin/owner explicitly, mirroring the
 * sibling `require-two-factor` procedures.
 *
 * The bounds live in `@repo/utils/attachment` and are exercised for real here —
 * the harness parses input through the procedure's own zod schema, so widening
 * a bound in the procedure fails this file.
 *
 * The read deliberately returns the server default alongside the stored value,
 * so the settings form never holds its own copy of 90.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getOrgRetention: vi.fn(),
		updateOrgRetention: vi.fn(),
		verifyOrganizationMembership: vi.fn(),
		requireOrgMembership: vi.fn(),
		recordAudit: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getOrganizationAttachmentRetention: (...a: unknown[]) =>
		mocks.getOrgRetention(...a),
	updateOrganizationAttachmentRetention: (...a: unknown[]) =>
		mocks.updateOrgRetention(...a),
}));

vi.mock("../../../lib/membership", () => ({
	verifyOrganizationMembership: (...a: unknown[]) =>
		mocks.verifyOrganizationMembership(...a),
	requireOrgMembership: (...a: unknown[]) => mocks.requireOrgMembership(...a),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mocks.recordAudit(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	/**
	 * A FRESH chainable per procedure chain. A shared singleton would let the
	 * second procedure's `.input()` overwrite the first's schema, and the bounds
	 * assertions would then be validating the wrong shape — silently.
	 */
	type Chainable = Record<string, unknown> & {
		_schema?: { parse?: (v: unknown) => unknown };
		_output?: { parse?: (v: unknown) => unknown };
	};
	const makeBuilder = (): Chainable => {
		const builder: Chainable = {};
		Object.assign(builder, {
			use: () => builder,
			route: () => builder,
			input: (schema: Chainable["_schema"]) => {
				builder._schema = schema;
				return builder;
			},
			output: (schema: Chainable["_output"]) => {
				builder._output = schema;
				return builder;
			},
			handler: (fn: (...args: unknown[]) => unknown) => ({
				_handler: fn,
				_schema: builder._schema,
				_output: builder._output,
			}),
		});
		return builder;
	};

	return {
		tenantProtectedProcedure: {
			use: (...a: unknown[]) =>
				(makeBuilder().use as (...x: unknown[]) => unknown)(...a),
			route: (...a: unknown[]) =>
				(makeBuilder().route as (...x: unknown[]) => unknown)(...a),
			input: (...a: unknown[]) =>
				(makeBuilder().input as (...x: unknown[]) => unknown)(...a),
		},
		requirePermission: vi.fn(() => ({})),
		Permissions: new Proxy({}, { get: (_t, prop: string) => String(prop) }),
	};
});

import {
	getOrganizationAttachmentRetentionProcedure,
	updateOrganizationAttachmentRetentionProcedure,
} from "../index";

const ORG_ID = "org-1";
const context = {
	user: { id: "user-1", email: "user@example.com" },
	session: { id: "sess-1" },
};

type BuiltProcedure = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
	_schema?: { parse: (v: unknown) => unknown };
	_output?: { parse: (v: unknown) => unknown };
};

/**
 * Invoke a procedure the way the runtime does: parse the input through its own
 * zod schema, run the handler, then validate the result against the declared
 * output contract — an output schema that does not admit what the handler
 * returns is a real defect that otherwise only surfaces in production.
 */
async function invoke(procedure: unknown, input: Record<string, unknown>) {
	const built = procedure as BuiltProcedure;
	const parsed = built._schema ? built._schema.parse(input) : input;
	const result = await built._handler({ input: parsed, context });
	built._output?.parse(result);
	return result;
}

const callGet = (input: Record<string, unknown>) =>
	invoke(getOrganizationAttachmentRetentionProcedure, input);
const callUpdate = (input: Record<string, unknown>) =>
	invoke(updateOrganizationAttachmentRetentionProcedure, input);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.verifyOrganizationMembership.mockResolvedValue({
		organization: { id: ORG_ID },
		role: "member",
	});
	mocks.requireOrgMembership.mockResolvedValue({
		organization: { id: ORG_ID },
		role: "admin",
	});
	mocks.getOrgRetention.mockResolvedValue({
		attachmentRetentionDays: null,
		attachmentRetentionDaysUpdatedAt: null,
	});
	mocks.updateOrgRetention.mockImplementation(
		async (input: { attachmentRetentionDays: number | null }) => ({
			attachmentRetentionDays: input.attachmentRetentionDays,
		}),
	);
});

describe("organizations.attachmentRetention.update", () => {
	it("re-checks admin/owner and rejects a plain member", async () => {
		// `requireOrgMembership` returns null when the role is not allowed.
		mocks.requireOrgMembership.mockResolvedValue(null);
		await expect(
			callUpdate({
				organizationId: ORG_ID,
				attachmentRetentionDays: 180,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateOrgRetention).not.toHaveBeenCalled();
		expect(mocks.requireOrgMembership).toHaveBeenCalledWith(
			"user-1",
			ORG_ID,
			["admin", "owner"],
		);
	});

	it("rejects a value below the minimum", async () => {
		await expect(
			callUpdate({ organizationId: ORG_ID, attachmentRetentionDays: 29 }),
		).rejects.toThrow();
		expect(mocks.updateOrgRetention).not.toHaveBeenCalled();
	});

	it("rejects a value above the maximum", async () => {
		await expect(
			callUpdate({
				organizationId: ORG_ID,
				attachmentRetentionDays: 3651,
			}),
		).rejects.toThrow();
		expect(mocks.updateOrgRetention).not.toHaveBeenCalled();
	});

	it("accepts the exact boundary values", async () => {
		await callUpdate({
			organizationId: ORG_ID,
			attachmentRetentionDays: 30,
		});
		await callUpdate({
			organizationId: ORG_ID,
			attachmentRetentionDays: 3650,
		});
		expect(mocks.updateOrgRetention).toHaveBeenCalledTimes(2);
	});

	it("stores the value and returns what was persisted", async () => {
		const result = await callUpdate({
			organizationId: ORG_ID,
			attachmentRetentionDays: 180,
		});
		expect(mocks.updateOrgRetention).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			attachmentRetentionDays: 180,
		});
		expect(result).toEqual({ success: true, attachmentRetentionDays: 180 });
	});

	it("accepts null to clear the override", async () => {
		const result = await callUpdate({
			organizationId: ORG_ID,
			attachmentRetentionDays: null,
		});
		expect(mocks.updateOrgRetention).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			attachmentRetentionDays: null,
		});
		expect(result).toEqual({
			success: true,
			attachmentRetentionDays: null,
		});
	});

	it("emits an audit event carrying the persisted value", async () => {
		// `recordAuditFromRequest` takes TWO positional args and the actor comes
		// from `context` — there is no userId field to pass.
		await callUpdate({
			organizationId: ORG_ID,
			attachmentRetentionDays: 180,
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "org.settings.updated",
				category: "org",
				organizationId: ORG_ID,
				resource: {
					type: "organization",
					id: ORG_ID,
					name: null,
				},
				metadata: expect.objectContaining({
					setting: "attachmentRetentionDays",
					value: 180,
				}),
			}),
		);
	});
});

describe("organizations.attachmentRetention.get", () => {
	it("returns the server default alongside a cleared value", async () => {
		const result = await callGet({ organizationId: ORG_ID });
		expect(result).toEqual({
			attachmentRetentionDays: null,
			effectiveDefault: 90,
			settingChangedAt: null,
		});
	});

	it("returns the stored value and the timestamp that arms the grace floor", async () => {
		const changedAt = new Date("2026-08-01T00:00:00.000Z");
		mocks.getOrgRetention.mockResolvedValue({
			attachmentRetentionDays: 365,
			attachmentRetentionDaysUpdatedAt: changedAt,
		});
		const result = await callGet({ organizationId: ORG_ID });
		expect(result).toEqual({
			attachmentRetentionDays: 365,
			effectiveDefault: 90,
			settingChangedAt: changedAt,
		});
	});

	it("rejects a caller who is not a member of the organization", async () => {
		mocks.verifyOrganizationMembership.mockResolvedValue(null);
		await expect(callGet({ organizationId: ORG_ID })).rejects.toMatchObject(
			{
				code: "FORBIDDEN",
			},
		);
		expect(mocks.getOrgRetention).not.toHaveBeenCalled();
	});
});

import { expect, it } from "vitest";
import {
	createTenantContextFromSession,
	getCurrentOrganizationId,
	getCurrentUserId,
	getTenantContextParams,
	getTenantContextSQL,
	isOrganizationContext,
	isPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";

const userId = "example-user";
const organizationId = "example-org";

it.each([null, undefined, organizationId])(
	"resolves a session organization of %s",
	async (activeOrganizationId) => {
		const session =
			activeOrganizationId === undefined
				? { userId }
				: { userId, activeOrganizationId };
		const context = createTenantContextFromSession(session);
		const type = activeOrganizationId ? "organization" : "personal";
		const tenantId = activeOrganizationId ?? userId;
		await runWithTenantContext(context, async () => {
			await Promise.resolve();
			expect(isOrganizationContext()).toBe(type === "organization");
			expect(isPersonalContext()).toBe(type === "personal");
			expect(getCurrentOrganizationId()).toBe(
				activeOrganizationId ?? null,
			);
			expect(getCurrentUserId()).toBe(userId);
			expect(getTenantContextParams()).toEqual({
				tenantType: type,
				tenantId,
				userId,
			});
			expect(getTenantContextSQL()).toEqual([
				`SET LOCAL app.tenant_type = '${type}'`,
				`SET LOCAL app.tenant_id = '${tenantId}'`,
				`SET LOCAL app.user_id = '${userId}'`,
			]);
		});
		expect(getCurrentUserId()).toBeNull();
	},
);

const denySQL = [
	"SET LOCAL app.tenant_type = 'none'",
	"SET LOCAL app.tenant_id = ''",
	"SET LOCAL app.user_id = ''",
];

it("uses empty RLS settings without a request context", () => {
	expect(isOrganizationContext()).toBe(false);
	expect(isPersonalContext()).toBe(false);
	expect(getCurrentOrganizationId()).toBeNull();
	expect(getCurrentUserId()).toBeNull();
	expect(getTenantContextParams()).toEqual({
		tenantType: "none",
		tenantId: "",
		userId: "",
	});
	expect(getTenantContextSQL()).toEqual(denySQL);
});

it("clears RLS settings when the request has no tenant ID", () => {
	const context = createTenantContextFromSession({
		userId,
		activeOrganizationId: organizationId,
	});
	runWithTenantContext({ ...context, tenantId: null }, () => {
		expect(getTenantContextSQL()).toEqual(denySQL);
	});
});

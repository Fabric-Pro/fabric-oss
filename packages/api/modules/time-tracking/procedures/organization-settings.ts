import { ORPCError } from "@orpc/server";
import {
	loadOrganizationTimePolicy,
	type TimePolicyRow,
	updateOrganizationTimePolicy,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	isSettingChange,
	type SettingChanges,
	serializeOrganizationTimeSettings,
} from "../lib/time-settings";

function requireOrganizationId(
	organizationId: string,
	session: { activeOrganizationId?: string | null },
): string {
	const resolved = resolveOrganizationId(organizationId, session);
	if (!resolved) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId is required",
		});
	}
	return resolved;
}

async function requireOrganizationTimePolicy(
	organizationId: string,
): Promise<TimePolicyRow> {
	const policy = await loadOrganizationTimePolicy(organizationId);
	if (!policy) {
		throw new ORPCError("NOT_FOUND", {
			message: "Organization not found",
		});
	}
	return policy;
}

export const getOrganizationTimeSettingsInputSchema = z.object({
	organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * The organization's time policy, which every project adds to, and what it
 * resolves to for a project with no settings of its own.
 */
export const getOrganizationTimeSettingsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/organizations/{organizationId}/settings",
		tags: ["Time tracking"],
		summary: "Get the organization's time-tracking settings",
		description:
			"The organization's start/stop requirement and billable default (null means billable), and the effective rules for a project with no settings of its own.",
	})
	.input(getOrganizationTimeSettingsInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationId(
			input.organizationId,
			context.session,
		);
		return serializeOrganizationTimeSettings(
			organizationId,
			await requireOrganizationTimePolicy(organizationId),
		);
	});

export const updateOrganizationTimeSettingsInputSchema = z.object({
	organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
	/** Applies to every project; a project can add to it, never lift it. */
	timeRequireStartStop: z.boolean().optional(),
	timeDefaultBillable: z.boolean().optional(),
});

/**
 * Change the organization's time policy. Omitted fields are kept. Applies to
 * new entries only: existing entries keep the start/stop rule and billable
 * flag they were saved with. A request that changes nothing writes nothing,
 * audit row included.
 */
export const updateOrganizationTimeSettingsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PUT",
		path: "/time-tracking/organizations/{organizationId}/settings",
		tags: ["Time tracking"],
		summary: "Change the organization's time-tracking settings",
		description:
			"Changes the given fields of the organization's start/stop requirement and billable default. Existing entries are not changed.",
	})
	.input(updateOrganizationTimeSettingsInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationId(
			input.organizationId,
			context.session,
		);
		const before = await requireOrganizationTimePolicy(organizationId);

		const values: Partial<TimePolicyRow> = {};
		const changes: SettingChanges = {};
		if (
			isSettingChange(
				before.timeRequireStartStop,
				input.timeRequireStartStop,
			)
		) {
			values.timeRequireStartStop = input.timeRequireStartStop;
			changes.timeRequireStartStop = {
				before: before.timeRequireStartStop,
				after: input.timeRequireStartStop,
			};
		}
		if (
			isSettingChange(
				before.timeDefaultBillable,
				input.timeDefaultBillable,
			)
		) {
			values.timeDefaultBillable = input.timeDefaultBillable;
			changes.timeDefaultBillable = {
				before: before.timeDefaultBillable,
				after: input.timeDefaultBillable,
			};
		}

		if (Object.keys(changes).length === 0) {
			return serializeOrganizationTimeSettings(organizationId, before);
		}

		const after = await updateOrganizationTimePolicy({
			organizationId,
			values,
		});
		recordAuditFromRequest(context, {
			action: "org.settings.updated",
			category: "org",
			organizationId,
			resource: { type: "organization", id: organizationId, name: null },
			metadata: { setting: "time_tracking", changes },
		});
		return serializeOrganizationTimeSettings(organizationId, after);
	});

import { ORPCError } from "@orpc/server";
import {
	type ProjectTimeSettingsValues,
	updateProjectTimeSettings,
} from "@repo/database";
import { PROJECT_BILLING_MODEL_VALUES } from "@repo/utils/time-tracking";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	PROJECT_NOT_FOUND_MESSAGE,
	projectNotFoundUnlessVisible,
} from "../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	liveTimeTrackingProject,
	requireLiveTimeTrackingProject,
} from "../lib/save-entry";
import {
	isSettingChange,
	type SettingChanges,
	serializeProjectTimeSettings,
} from "../lib/time-settings";

export const getProjectTimeSettingsInputSchema = z.object({
	projectId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * A project's billing model and time policy, the organization policy it adds
 * to, and the rules a new entry on it is saved under.
 */
export const getProjectTimeSettingsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/time-tracking/projects/{projectId}/settings",
		tags: ["Time tracking"],
		summary: "Get a project's time-tracking settings",
		description:
			"The project's billing model, start/stop requirement and billable default, the organization's policy, and the effective rules for new entries.",
	})
	.input(getProjectTimeSettingsInputSchema)
	.handler(async ({ input }) =>
		serializeProjectTimeSettings(
			await requireLiveTimeTrackingProject(input.projectId),
		),
	);

export const updateProjectTimeSettingsInputSchema = z.object({
	projectId: z.string().min(1).max(INPUT_BOUNDS.name),
	billingModel: z.enum(PROJECT_BILLING_MODEL_VALUES).optional(),
	timeRequireStartStop: z.boolean().optional(),
	/** `null` inherits the organization's default. */
	timeDefaultBillable: z.boolean().nullable().optional(),
});

/**
 * Change a project's billing model and time policy. Omitted fields are kept.
 * Applies to new entries only: existing entries keep the start/stop rule and
 * billable flag they were saved with. A request that changes nothing writes
 * nothing, audit row included.
 */
export const updateProjectTimeSettingsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/time-tracking/projects/{projectId}/settings",
		tags: ["Time tracking"],
		summary: "Change a project's time-tracking settings",
		description:
			"Changes the given fields of the project's billing model, start/stop requirement and billable default (null inherits the organization's). Existing entries are not changed.",
	})
	.input(updateProjectTimeSettingsInputSchema)
	.handler(async ({ input, context }) => {
		const before = await requireLiveTimeTrackingProject(input.projectId);

		const values: ProjectTimeSettingsValues = {};
		const changes: SettingChanges = {};
		if (isSettingChange(before.billingModel, input.billingModel)) {
			values.billingModel = input.billingModel;
			changes.billingModel = {
				before: before.billingModel,
				after: input.billingModel,
			};
		}
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

		const changedFields = Object.keys(changes);
		if (changedFields.length === 0) {
			return serializeProjectTimeSettings(before);
		}

		const after = liveTimeTrackingProject(
			await updateProjectTimeSettings({
				projectId: before.id,
				values,
			}),
		);
		if (!after) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		}

		recordAuditFromRequest(context, {
			action: "project.updated",
			category: "project",
			organizationId: after.organizationId,
			projectId: after.id,
			resource: { type: "project", id: after.id, name: after.name },
			metadata: {
				operation: "time_settings_updated",
				changedFields,
				changes,
			},
		});
		return serializeProjectTimeSettings(after);
	});

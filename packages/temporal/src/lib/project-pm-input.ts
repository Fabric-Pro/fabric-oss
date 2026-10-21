import { z } from "zod";
import {
	adoStoryReviewConfigFieldsSchema,
	adoStoryReviewStrictAssigneeSchema,
} from "./ado-story-review-config";

const project = z.object({ projectId: z.string().min(1).max(128) }).strict();
const asOf = z.string().max(512).datetime({ offset: true });
const itemId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fields = adoStoryReviewConfigFieldsSchema.shape;

export const projectPmToolInput = z.discriminatedUnion("name", [
	z.object({
		name: z.literal("fabric_get_project_pm_connection"),
		input: project,
	}),
	z.object({
		name: z.literal("fabric_list_project_pm_members"),
		input: project,
	}),
	z.object({
		name: z.literal("fabric_list_project_pm_work_item_types"),
		input: project,
	}),
	z.object({
		name: z.literal("fabric_get_project_work_item_counts"),
		input: project.extend({
			state: z.string().min(1).max(128).default("In Development"),
			assignee: z.string().min(1).max(512).optional(),
		}),
	}),
	z.object({
		name: z.literal("fabric_list_project_pm_assigned_items"),
		input: project.extend({
			assignee: adoStoryReviewStrictAssigneeSchema.default({
				mode: "current",
			}),
			workItemTypes: fields.workItemTypes,
			cursor: z
				.object({ afterId: itemId, requirementsAsOf: asOf })
				.strict()
				.optional(),
		}),
	}),
	z.object({
		name: z.literal("fabric_get_project_pm_item_snapshots"),
		input: project.extend({
			ids: z
				.array(itemId)
				.min(1)
				.max(10)
				.refine((ids) => new Set(ids).size === ids.length),
			requirementsAsOf: asOf,
			requirementFields: fields.requirementFields,
		}),
	}),
]);

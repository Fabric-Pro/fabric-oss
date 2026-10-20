import { isTextContentType, listAvailableSkillPage } from "@repo/ai/skills";
import {
	canReadOrganizationAgentTemplates,
	canReadOrganizationSkills,
	db,
	listAgentTemplateInstances,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import { z } from "zod";
import { authorizeInputOrganization } from "../../../orpc/middleware/require-permission";
import { listAvailableModels } from "./available-models";

const offset = z.number().int().min(0).max(100_000).default(0);
export const reviewSelectorPageSchema = z.object({
	modelOffset: offset,
	planModelOffset: offset,
	instructionOffset: offset,
	skillOffset: offset,
	limit: z.number().int().min(1).max(50).default(25),
});

const identifier = z.string().trim().min(1).max(256);
const label = (value: string) =>
	z.string().trim().min(1).max(200).parse(value.trim().slice(0, 200));
const mappings = z
	.array(
		z.object({
			provider: identifier,
			providerModelId: identifier,
			isAvailable: z.boolean(),
		}),
	)
	.max(100);

function page<T>(items: T[], offset: number, limit: number) {
	const hasMore = items.length > offset + limit;
	return {
		items: items.slice(offset, offset + limit),
		hasMore,
		nextOffset: hasMore ? offset + limit : null,
	};
}

/** Instructions and model preferences only; these selections never invoke agents or skill scripts. */
export async function listReviewSelectorOptions(
	context: { userId: string; organizationId: string },
	input: z.infer<typeof reviewSelectorPageSchema>,
) {
	await authorizeInputOrganization(
		Permissions.ORG_AI_CONFIG_READ,
		context.organizationId,
		{
			user: { id: context.userId },
			session: { activeOrganizationId: context.organizationId },
		},
		{ requireOrganization: true },
	);
	const [canReadAgents, canReadSkills] = await Promise.all([
		canReadOrganizationAgentTemplates(
			context.userId,
			context.organizationId,
		),
		canReadOrganizationSkills(context.userId, context.organizationId),
	]);
	if (!canReadAgents || !canReadSkills) {
		throw new Error("Review selector access denied");
	}
	const [available, instances, skillPage] = await Promise.all([
		listAvailableModels({
			...context,
			sessionOrganizationId: context.organizationId,
			taskType: "SIMPLE",
		}),
		listAgentTemplateInstances({
			...context,
			status: "ACTIVE",
			latestVersionOnly: true,
			limit: input.limit,
			offset: input.instructionOffset,
			sortBy: "name",
			sortOrder: "asc",
		}),
		listAvailableSkillPage(context, {
			offset: input.skillOffset,
			limit: input.limit,
		}),
	]);
	const templates = instances.instances.length
		? await db.agentTemplate.findMany({
				where: {
					id: {
						in: instances.instances.map(
							(instance) => instance.templateId,
						),
					},
				},
				select: { id: true, suggestedModel: true },
			})
		: [];
	const templateModels = new Map(
		templates.map((template) => [template.id, template.suggestedModel]),
	);
	const instructionsHaveMore =
		input.instructionOffset + instances.instances.length < instances.total;
	const plan = available.chatgptPlan;
	return {
		semantics:
			"Agent instructions/model preferences and published skill instructions/text files only; no agent tools or skill scripts execute.",
		taskType: "SIMPLE",
		defaultProvider: available.defaultProvider,
		models: page(
			available.models.map((model) => ({
				id: identifier.parse(model.id),
				canonicalName: identifier.parse(model.canonicalName),
				label: label(model.displayName),
				providerMappings: mappings.parse(model.providerMappings),
			})),
			input.modelOffset,
			input.limit,
		),
		chatgptPlan: plan
			? {
					model: identifier.parse(plan.model),
					source: plan.source,
					spent: plan.spent,
					models: page(
						plan.models.map((model) => ({
							...model,
							canonicalName: identifier.parse(
								model.canonicalName,
							),
							slug: identifier.parse(model.slug),
							displayName: label(model.displayName),
						})),
						input.planModelOffset,
						input.limit,
					),
				}
			: null,
		instructionInstances: {
			items: instances.instances.map((instance) => ({
				id: identifier.max(128).parse(instance.id),
				label: label(instance.name),
				version: instance.version,
				model: identifier
					.nullable()
					.parse(
						instance.modelOverride ||
							templateModels.get(instance.templateId) ||
							null,
					),
			})),
			hasMore: instructionsHaveMore,
			nextOffset: instructionsHaveMore
				? input.instructionOffset + input.limit
				: null,
		},
		skills: {
			items: skillPage.skills.map((skill) => ({
				slug: identifier.max(128).parse(skill.slug),
				label: label(skill.name),
				version: skill.version,
				textFiles: skill.files
					.filter(
						(file) =>
							file.path.length <= 256 &&
							/\.(?:md|txt|json|ya?ml|csv)$/i.test(file.path) &&
							Number.isSafeInteger(file.sizeBytes) &&
							file.sizeBytes >= 0 &&
							file.sizeBytes <= 20_000 &&
							isTextContentType(file.contentType),
					)
					.map((file) => ({
						path: identifier.parse(file.path),
						contentType: identifier
							.max(128)
							.parse(file.contentType),
						sizeBytes: file.sizeBytes,
					})),
				fileManifestComplete: skill.fileManifestComplete,
			})),
			hasMore: skillPage.hasMore,
			nextOffset: skillPage.hasMore
				? input.skillOffset + input.limit
				: null,
		},
	};
}

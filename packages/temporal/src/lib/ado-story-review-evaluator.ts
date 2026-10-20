import { loadSkillBundle, readSkillFile } from "@repo/ai/skills";
import {
	canReadOrganizationAgentTemplates,
	canReadOrganizationSkills,
	getInstanceWithTemplate,
} from "@repo/database";
import { z } from "zod";
import type { AdoStoryReviewConfig } from "./ado-story-review-config";
import { buildAgentInstructions } from "./agent-instructions";

/** Instruction-only selection: no tools, workspace discovery, scripts or agent invocation. */
export async function loadReviewEvaluator(
	config: AdoStoryReviewConfig,
	context: { userId: string; organizationId: string },
) {
	let agent: {
		id: string;
		version: number;
		instructions: string;
		model?: string;
	} | null = null;
	if (config.agentInstructionsInstanceId) {
		if (
			!(await canReadOrganizationAgentTemplates(
				context.userId,
				context.organizationId,
			))
		) {
			throw new Error("Agent instruction access is no longer permitted");
		}
		const instance = await getInstanceWithTemplate(
			config.agentInstructionsInstanceId,
			context.userId,
			context.organizationId,
		);
		if (
			!instance ||
			instance.status !== "ACTIVE" ||
			instance.organizationId !== context.organizationId
		) {
			throw new Error("Agent instructions unavailable");
		}
		const customInstructions = z
			.record(z.string(), z.unknown())
			.nullable()
			.parse(instance.customInstructions);
		agent = {
			id: instance.id,
			version: instance.version,
			instructions: buildAgentInstructions(instance.template, {
				description: instance.description,
				customInstructions,
			}),
			model:
				instance.modelOverride ||
				instance.template.suggestedModel ||
				undefined,
		};
	}
	const skills: Array<{
		slug: string;
		version: number;
		instructions: string;
		files: Array<{ path: string; content: string }>;
	}> = [];
	if (
		config.skills.length > 0 &&
		!(await canReadOrganizationSkills(
			context.userId,
			context.organizationId,
		))
	) {
		throw new Error("Skill access is no longer permitted");
	}
	for (const selection of config.skills) {
		const bundle = await loadSkillBundle(selection.slug, context, {
			fresh: true,
		});
		const files: Array<{ path: string; content: string }> = [];
		for (const path of selection.textFiles) {
			const entry = bundle.files.find((file) => file.path === path);
			if (!entry || entry.sizeBytes > 20_000) {
				throw new Error("Skill text file unavailable or too large");
			}
			const file = await readSkillFile(selection.slug, path, context, {
				fresh: true,
				expectedVersion: bundle.version,
			});
			if (file.encoding !== "utf-8" || file.data.length > 20_000) {
				throw new Error("Skill file is not bounded text");
			}
			files.push({ path, content: file.data });
		}
		skills.push({
			slug: bundle.slug,
			version: bundle.version,
			instructions: bundle.skillMd,
			files,
		});
		if (JSON.stringify(skills).length > 40_000) {
			throw new Error("Skill instructions exceed limit");
		}
	}
	if ((agent?.instructions.length ?? 0) > 20_000) {
		throw new Error("Agent instructions exceed limit");
	}
	return { agent, skills };
}

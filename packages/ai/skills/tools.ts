/**
 * AI SDK tools that expose the skill runtime to a model via progressive disclosure.
 *
 * The system prompt carries a one-line-per-skill registry (see prompt-fragment.ts);
 * the model uses these tools when it decides it needs a skill's full instructions
 * or file contents. Mirrors Vercel AI SDK's skill tool shape:
 *   https://ai-sdk.dev/cookbook/guides/agent-skills
 */

import { tool } from "ai";
import { z } from "zod";
import {
	listAvailableSkills,
	loadSkillBundle,
	MAX_SKILL_FILE_READ_BYTES,
	readSkillFile,
	type SkillContext,
} from "./loader";

export interface CreateSkillToolsOptions {
	/**
	 * When `false`, the returned tools carry only schemas (no `execute`
	 * handler). Use this in surfaces like the Temporal orchestrator where
	 * tool execution is deferred to a separate workflow dispatcher — an
	 * inline `execute` would cause the AI SDK to auto-run the tool during
	 * `streamText` AND the workflow to run it a second time. Default: true.
	 */
	withExecute?: boolean;
}

const LIST_SKILLS_DESCRIPTION =
	"List the skills available in this conversation. Each result is a summary; call load_skill to get the full instructions for a skill before using it. Skills are specialized capability packs — use them when the task matches a skill's description.";

const LOAD_SKILL_DESCRIPTION =
	"Load a skill's full SKILL.md instructions and file manifest. Returns `skillMd` (the instructions — follow them) and `files` (the manifest of additional files). For each file listed, call read_skill_file ONLY if the instructions say to use it.";

const READ_SKILL_FILE_DESCRIPTION = `Read a file inside a skill (assets/, references/, or scripts/). Returns { contentType, encoding, data }. Encoding is "utf-8" for text and "base64" for binary. Per-call limit: ${MAX_SKILL_FILE_READ_BYTES} bytes. Prefer load_skill's manifest first — don't guess paths.`;

const LIST_SKILLS_SCHEMA = z.object({});
const LOAD_SKILL_SCHEMA = z.object({
	slug: z.string().describe("The skill slug, e.g. 'architecture-diagram'"),
});
const READ_SKILL_FILE_SCHEMA = z.object({
	slug: z.string(),
	path: z
		.string()
		.describe(
			"The file path inside the skill folder, exactly as listed in load_skill.files (e.g. 'assets/template.html').",
		),
});

export function createSkillTools(
	ctx: SkillContext,
	options: CreateSkillToolsOptions = {},
) {
	const { withExecute = true } = options;

	if (!withExecute) {
		// Schema-only tools. Used by surfaces where tool execution is
		// deferred to a separate dispatcher (e.g. the Temporal orchestrator's
		// iterative workflow). An inline `execute` in those contexts would
		// cause the AI SDK to auto-run the tool inside streamText while the
		// workflow also runs it via its dispatcher — double execution and
		// lost final-text responses on the same stream.
		return {
			list_skills: tool({
				description: LIST_SKILLS_DESCRIPTION,
				inputSchema: LIST_SKILLS_SCHEMA,
			}),
			load_skill: tool({
				description: LOAD_SKILL_DESCRIPTION,
				inputSchema: LOAD_SKILL_SCHEMA,
			}),
			read_skill_file: tool({
				description: READ_SKILL_FILE_DESCRIPTION,
				inputSchema: READ_SKILL_FILE_SCHEMA,
			}),
		};
	}

	return {
		list_skills: tool({
			description: LIST_SKILLS_DESCRIPTION,
			inputSchema: LIST_SKILLS_SCHEMA,
			execute: async () => {
				const skills = await listAvailableSkills(ctx);
				return {
					skills: skills.map((s) => ({
						slug: s.slug,
						name: s.name,
						description: s.description,
						version: s.version,
						category: s.category,
						tags: s.tags,
						files: s.files,
					})),
				};
			},
		}),

		load_skill: tool({
			description: LOAD_SKILL_DESCRIPTION,
			inputSchema: LOAD_SKILL_SCHEMA,
			execute: async ({ slug }) => {
				const bundle = await loadSkillBundle(slug, ctx);
				return {
					slug: bundle.slug,
					name: bundle.name,
					description: bundle.description,
					version: bundle.version,
					skillMd: bundle.skillMd,
					files: bundle.files,
				};
			},
		}),

		read_skill_file: tool({
			description: READ_SKILL_FILE_DESCRIPTION,
			inputSchema: READ_SKILL_FILE_SCHEMA,
			execute: async ({ slug, path }) => {
				return readSkillFile(slug, path, ctx);
			},
		}),
	};
}

/**
 * Weave Delegation Enrichment
 *
 * Enriches delegation messages to weave agents with:
 * 1. Resolved skill content from ProjectWeaveConfig
 * 2. RAG-retrieved project context (architecture, requirements, decisions)
 * 3. Project fingerprint (stack, frameworks, etc.)
 * 4. Sandbox session context
 *
 * Called by the orchestrator before delegating to weave agents.
 */

import { db, hasProjectAccess } from "@repo/database";

const WEAVE_AGENT_IDS = new Set([
	"weave_thread",
	"weave_spindle",
	"weave_weft",
	"weave_warp",
	"weave_shuttle",
]);

// Agents that benefit from RAG context about the project
const RAG_ELIGIBLE_AGENTS = new Set([
	"weave_thread",
	"weave_weft",
	"weave_warp",
	"weave_shuttle",
]);

/**
 * Check if an agent ID is a weave agent.
 */
export function isWeaveAgent(agentId: string): boolean {
	return WEAVE_AGENT_IDS.has(agentId);
}

/**
 * Enrich a delegation message with skills and context for a weave agent.
 *
 * Returns the enriched message string with skill content prepended.
 * Returns the original message unchanged if:
 * - The agent is not a weave agent
 * - No skills are configured
 * - The project has no weave config
 */
export async function enrichWeaveDelegationMessage(input: {
	agentId: string;
	message: string;
	projectId?: string;
	userId: string;
	organizationId?: string;
	sandboxSessionId?: string;
}): Promise<string> {
	if (!isWeaveAgent(input.agentId) || !input.projectId) {
		return input.message;
	}

	const parts: string[] = [];

	// 1. Verify project access (supports org collaborators, not just owner)
	let projectVerified = false;
	try {
		const canAccess = await hasProjectAccess(
			input.projectId,
			input.userId,
			input.organizationId,
		);

		if (!canAccess) {
			return input.message;
		}
		projectVerified = true;
	} catch (error) {
		// FAIL-CLOSED: If we can't verify access, don't enrich
		console.warn(
			"[WeaveEnrichment] Access check failed — proceeding without enrichment",
			{ projectId: input.projectId, error: String(error) },
		);
		return input.message;
	}

	// 1b. Inject skills (only after ownership is verified)
	if (projectVerified) {
		try {
			const config = await db.projectWeaveConfig.findUnique({
				where: { projectId: input.projectId },
			});

			if (config && config.enabledSkills.length > 0) {
				const agentName = input.agentId.replace("weave_", "");
				const skills = await db.skill.findMany({
					where: {
						id: { in: config.enabledSkills },
					},
					select: { name: true, description: true, content: true },
				});

				if (skills.length > 0) {
					const skillContent = skills
						.map(
							(s) =>
								`### ${s.name}\n${s.description ? `${s.description}\n\n` : ""}${s.content}`,
						)
						.join("\n\n---\n\n");
					parts.push(
						`<project-skills agent="${agentName}">\n${skillContent}\n</project-skills>`,
					);
				}
			}
		} catch {
			// Skills are optional — ownership already verified
		}
	}

	// 2. Retrieve RAG context for eligible agents
	if (RAG_ELIGIBLE_AGENTS.has(input.agentId) && input.projectId) {
		try {
			const { retrieveProjectContexts, contextMetaHeader } = await import(
				"@repo/rag"
			);

			// Use the delegation message as the RAG query for relevance
			const results = await retrieveProjectContexts({
				projectId: input.projectId,
				query: input.message,
				userId: input.userId,
				organizationId: input.organizationId,
				topK: 5,
			});

			if (results && results.length > 0) {
				const ragContent = results
					.map(
						(
							r: {
								content: string;
								metadata?: { filename?: string; type?: string };
								sourceType?: string;
								aiInstructions?: string;
							},
							i: number,
						) => {
							const source =
								r.metadata?.filename ??
								r.metadata?.type ??
								`Context ${i + 1}`;
							// Type label + AI guidance (#1888): metadata
							// arrives flag-gated; header is "" when unset.
							return `### ${source}\n${contextMetaHeader(r)}${r.content}`;
						},
					)
					.join("\n\n---\n\n");

				parts.push(
					`<project-rag-context agent="${input.agentId.replace("weave_", "")}">\n${ragContent}\n</project-rag-context>`,
				);
			}
		} catch {
			// RAG is best-effort — embedding model may not be configured
		}
	}

	// 3. Inject sandbox session context
	if (input.sandboxSessionId) {
		parts.push(`<sandbox-session id="${input.sandboxSessionId}" />`);
	}

	// 4. Inject project context (stack, frameworks)
	// Project ownership already validated above — safe to query by ID for extra fields
	try {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				name: true,
				description: true,
				techStack: true,
			},
		});

		if (project) {
			const contextParts: string[] = [];
			if (project.name) {
				contextParts.push(`Project: ${project.name}`);
			}
			if (project.techStack && project.techStack.length > 0) {
				contextParts.push(`Stack: ${project.techStack.join(", ")}`);
			}

			if (contextParts.length > 0) {
				parts.push(
					"<project-context>\n" +
						contextParts.join("\n") +
						"\n</project-context>",
				);
			}
		}
	} catch {
		// Project context is optional
	}

	if (parts.length === 0) {
		return input.message;
	}

	return `${parts.join("\n\n")}\n\n${input.message}`;
}

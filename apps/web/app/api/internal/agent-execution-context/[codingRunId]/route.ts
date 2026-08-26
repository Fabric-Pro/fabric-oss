/**
 * Internal: Agent Execution Context Endpoint
 *
 * Called by fabric-bot to fetch enriched context for building the implementation prompt.
 * Returns story, project, Weave plan, docs, RAG, and model config for a given CodingRun.
 *
 * AUTH: X-Agent-Service-Token header matching AGENT_SERVICE_SECRET
 *
 * Response shape matches fabric-bot's AgentExecutionContext type exactly.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { db, resolveModel } from "@repo/database";
import { contextMetaHeader } from "@repo/rag";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Constant-time secret comparison (SOC 2 CC6.1). Both sides are hashed to a
 * fixed-length SHA-256 digest first, so the compare never leaks length through
 * an early return and never throws on a length mismatch (`timingSafeEqual`
 * requires equal-length buffers). Returns false when either side is empty —
 * an unset `AGENT_SERVICE_SECRET` therefore fails closed.
 */
function constantTimeEqual(
	provided: string,
	expected: string | undefined,
): boolean {
	if (!provided || !expected) {
		return false;
	}
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

// Keep documents to a reasonable size so they don't dominate the prompt.
// fabric-bot may further trim or excerpt based on its own context budget.
const MAX_DOC_CHARS = 8_000;

function truncateDoc(content: string | null): string | null {
	if (!content || content.length <= MAX_DOC_CHARS) {
		return content;
	}
	return `${content.slice(0, MAX_DOC_CHARS)}\n\n[…document truncated at ${MAX_DOC_CHARS} characters]`;
}

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ codingRunId: string }> },
) {
	const secret = request.headers.get("X-Agent-Service-Token");
	if (!constantTimeEqual(secret ?? "", process.env.AGENT_SERVICE_SECRET)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { codingRunId } = await params;

	const codingRun = await db.codingRun.findUnique({
		where: { id: codingRunId },
		include: {
			story: {
				include: {
					tasks: {
						where: { isCompleted: false },
						orderBy: { order: "asc" },
					},
					project: {
						select: {
							id: true,
							name: true,
							description: true,
							techStack: true,
							repositoryUrl: true,
							repositoryOwner: true,
							repositoryName: true,
							defaultBranch: true,
							organizationId: true,
						},
					},
				},
			},
		},
	});

	if (!codingRun) {
		return NextResponse.json(
			{ error: "CodingRun not found" },
			{ status: 404 },
		);
	}

	const story = codingRun.story;
	const project = story?.project ?? null;

	// The focused task is the one linked via storyTaskId (if any)
	const focusedTask =
		codingRun.storyTaskId && story
			? (story.tasks.find((t) => t.id === codingRun.storyTaskId) ?? null)
			: null;

	// Fetch Weave plan if linked
	let weave: {
		executionId: string;
		planId: string | null;
		planName: string | null;
		approvedSteps: string[];
		category: string | null;
	} | null = null;

	if (codingRun.weaveExecutionId) {
		const execution = await db.weaveExecution.findUnique({
			where: { id: codingRun.weaveExecutionId },
			include: {
				plan: { select: { id: true, name: true, checkboxes: true } },
			},
		});
		if (execution) {
			const checkboxes =
				(execution.plan.checkboxes as Array<{
					id: string;
					label: string;
					approved?: boolean;
					category?: string;
				}>) ?? [];
			weave = {
				executionId: execution.id,
				planId: execution.plan.id,
				planName: execution.plan.name,
				approvedSteps: checkboxes
					.filter((cb) => cb.approved)
					.map((cb) => cb.label),
				category:
					checkboxes.find((cb) => cb.approved)?.category ?? null,
			};
		}
	}

	// Fetch published project documents
	const documents = {
		prd: null as string | null,
		technicalSpec: null as string | null,
		architecture: null as string | null,
	};

	if (project?.id) {
		const docs = await db.projectDocument.findMany({
			where: {
				projectId: project.id,
				type: { in: ["PRD", "TECHNICAL_SPEC", "ARCHITECTURE"] },
				status: "COMPLETE",
				isActive: true,
			},
			select: { type: true, content: true },
			orderBy: { updatedAt: "desc" },
		});
		for (const doc of docs) {
			if (doc.type === "PRD" && !documents.prd) {
				documents.prd = truncateDoc(doc.content);
			} else if (
				doc.type === "TECHNICAL_SPEC" &&
				!documents.technicalSpec
			) {
				documents.technicalSpec = truncateDoc(doc.content);
			} else if (doc.type === "ARCHITECTURE" && !documents.architecture) {
				documents.architecture = truncateDoc(doc.content);
			}
		}
	}

	// Fetch relevant project context snippets (raw imported content)
	const ragSnippets: Array<{ text: string; source: string | null }> = [];
	if (project?.id) {
		const query = [story?.title, story?.description]
			.filter(Boolean)
			.join(" ")
			.slice(0, 200);

		const contextRecords = await db.projectContext.findMany({
			where: {
				projectId: project.id,
				type: {
					in: [
						"TEXT",
						"DOCUMENT",
						"LINK",
						"INTEGRATION",
						"MEETING_TRANSCRIPT",
					],
				},
			},
			select: {
				content: true,
				type: true,
				sourceTitle: true,
				sourceType: true,
				aiInstructions: true,
			},
			orderBy: { createdAt: "desc" },
			take: 10,
		});

		// Simple keyword relevance: score by overlap with query terms
		const queryTerms = query
			.toLowerCase()
			.split(/\W+/)
			.filter((t) => t.length > 3);

		const scored = contextRecords.map((ctx) => {
			const text = ctx.content.toLowerCase();
			const score = queryTerms.filter((t) => text.includes(t)).length;
			return { ctx, score };
		});

		scored
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 5)
			.forEach(({ ctx }) => {
				ragSnippets.push({
					text: `${contextMetaHeader(ctx)}${ctx.content.slice(0, 1500)}`,
					source: ctx.sourceTitle ?? ctx.type,
				});
			});
	}

	// Resolve AI model from user/org settings, falling back to Claude Sonnet.
	let model: { model: string; reasoningEffort: string | null } = {
		model: "claude-sonnet-5",
		reasoningEffort: null,
	};
	try {
		const resolved = await resolveModel({
			userId: codingRun.userId,
			organizationId: codingRun.organizationId ?? null,
			taskType: "TOOL_CALLING",
			complexity: "COMPLEX",
		});
		model = {
			model: resolved.canonicalName,
			reasoningEffort: resolved.reasoningEffort ?? null,
		};
	} catch {
		// No provider configured or no model found — keep the default above.
	}

	return NextResponse.json({
		codingRun: {
			id: codingRun.id,
			provider: codingRun.provider,
			// sourceEntityType/Id reserved for future PM tool integration (Linear, Jira)
			sourceEntityType: null as string | null,
			sourceEntityId: null as string | null,
			workflowId: codingRun.workflowId,
		},
		story: story
			? {
					id: story.id,
					identifier: story.identifier,
					title: story.title,
					description: story.description,
					acceptanceCriteria: story.acceptanceCriteria,
					priority: story.priority as string,
					// All uncompleted tasks — prompt-builder filters focused task from this list
					tasks: story.tasks.map((t) => ({
						id: t.id,
						identifier: t.identifier,
						title: t.title,
						description: t.description,
					})),
				}
			: null,
		// Top-level focused task (null if this is a whole-story run)
		task: focusedTask
			? {
					id: focusedTask.id,
					identifier: focusedTask.identifier,
					title: focusedTask.title,
					description: focusedTask.description,
				}
			: null,
		project: project
			? {
					id: project.id,
					name: project.name,
					description: project.description,
					techStack: project.techStack,
					repositoryUrl: project.repositoryUrl,
					repositoryOwner: project.repositoryOwner,
					repositoryName: project.repositoryName,
					defaultBranch: project.defaultBranch,
				}
			: null,
		weave,
		documents,
		rag: { snippets: ragSnippets },
		model,
	});
}

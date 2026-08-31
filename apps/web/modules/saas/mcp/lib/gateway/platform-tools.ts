/**
 * Fabric MCP Gateway - Platform Tool Definitions & Handlers
 *
 * Exposes all Fabric platform capabilities as MCP tools:
 * - Identity & organization management
 * - Projects (list, get, create, update, delete)
 * - Documents (list, get, create, update)
 * - Workspaces & RAG queries
 * - Workflows (list, get, execute, check status)
 * - AI Chats
 * - Connected MCP servers (list)
 *
 * All tools enforce multi-tenant isolation via the gateway session.
 */

// The export's conversation-pointer classifier, reused rather than
// reimplemented (Fizzy #2228). Both surfaces answer "why is this row's body
// empty" about the same metadata, and the last time this repo kept two copies
// of one explanation, only one of them got fixed. Importing a pure leaf module
// — no I/O, no Prisma, no oRPC — keeps that from happening again.
import { classifyConversationPointer } from "@repo/api/modules/projects/lib/context-skip-reason";
import type {
	GatewaySession,
	GatewayToolDefinition,
	ToolCallResult,
} from "./types";

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const PLATFORM_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
	// ── Identity ──
	{
		name: "fabric_get_identity",
		description:
			"Returns the authenticated user's identity: userId, email, role, active organizationId, and the full list of organizations they belong to. " +
			"CALL THIS FIRST in any session to understand your context. " +
			"Returns 'mode': 'personal' (no org) or 'organization' (scoped to an org). " +
			"If you need to work in a specific org, use the organizationId from this response to call fabric_switch_organization.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_list_organizations",
		description:
			"Lists all organizations the current user belongs to, with their role (owner, admin, member) in each. " +
			"Returns organization IDs needed for fabric_switch_organization. " +
			"Use this if fabric_get_identity doesn't list an org you expect.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_switch_organization",
		description:
			"Switches the active organization context for this entire session. " +
			"After switching, ALL subsequent calls (fabric_list_projects, fabric_list_features, etc.) are scoped to that organization. " +
			"Pass organizationId=null to switch back to personal mode. " +
			"Get the organizationId from fabric_get_identity or fabric_list_organizations.",
		inputSchema: {
			type: "object",
			properties: {
				organizationId: {
					type: "string",
					nullable: true,
					description:
						"Organization ID from fabric_list_organizations, or null to switch to personal mode",
				},
			},
		},
		_gateway_source: "platform",
	},

	// ── Projects ──
	{
		name: "fabric_list_projects",
		description:
			"Lists all projects in the current context (personal or organization). " +
			"Returns project IDs, names, descriptions, and status. " +
			"Use the returned 'id' field as 'projectId' in fabric_list_features, fabric_list_documents, fabric_get_project_statuses, and other project-scoped tools. " +
			"Filter by status='ACTIVE' to find projects in progress.",
		inputSchema: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: ["ACTIVE", "ARCHIVED", "COMPLETED"],
					description:
						"Filter by project status. Omit to return all.",
				},
				search: {
					type: "string",
					description: "Search projects by name",
				},
				limit: {
					type: "number",
					description: "Max results per page (default 20, max 50)",
					default: 20,
				},
				offset: {
					type: "number",
					description: "Offset for pagination (default 0)",
					default: 0,
				},
			},
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_project",
		description:
			"Retrieves details for a single project: name, description, status, heroEmojis, and timestamps. " +
			"Use the projectId from fabric_list_projects. " +
			"After this, call fabric_list_features(projectId) to see features/stories, " +
			"or fabric_list_documents(projectId) to see PRDs and specs.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Project ID from fabric_list_projects",
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_create_project",
		description:
			"Creates a new project in the current context (personal or organization). " +
			"Returns the new project's id and name. " +
			"After creating, call fabric_list_features(projectId) or fabric_list_documents(projectId) to add content.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Project name",
				},
				description: {
					type: "string",
					description: "Optional project description",
				},
			},
			required: ["name"],
		},
		annotations: { destructiveHint: false },
		_gateway_source: "platform",
	},
	{
		name: "fabric_update_project",
		description:
			"Updates an existing project's name, description, or status (ACTIVE | ARCHIVED | COMPLETED). " +
			"Provide only the fields you want to change alongside the required projectId.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Project ID from fabric_list_projects",
				},
				name: { type: "string", description: "New project name" },
				description: {
					type: "string",
					description: "New project description",
				},
				status: {
					type: "string",
					enum: ["ACTIVE", "ARCHIVED", "COMPLETED"],
					description: "New project status",
				},
			},
			required: ["projectId"],
		},
		_gateway_source: "platform",
	},

	// ── Features ──
	{
		name: "fabric_list_features",
		description:
			"Lists work items for a project. Each has an identifier like 'F-001', a title, Kanban status, priority, size, and task counts. " +
			"BUGS ARE INCLUDED: the project backlog holds both features and bugs, and this tool returns both by default. Every row carries a 'kind' field ('FEATURE' or 'BUG'); pass kind='BUG' to see only bugs (e.g. what an autonomous monitor has filed via fabric_create_bug) or kind='FEATURE' to exclude them. " +
			"Use the returned 'id' field as 'featureId' in fabric_get_feature, fabric_update_feature_status, fabric_complete_task, and fabric_create_feature_task — those tools accept bugs too. " +
			"IMPORTANT: Filter draftingStage='PUBLISHED' to only see features that are fully spec'd and ready to implement. " +
			"PLACEHOLDER/DRAFT features are still being written and should not be implemented yet. " +
			"To find features ready to start: combine draftingStage='PUBLISHED' with the 'Backlog' statusId from fabric_get_project_statuses. " +
			"Response includes 'hasMore' to indicate additional pages.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Project ID from fabric_list_projects",
				},
				statusId: {
					type: "string",
					description:
						"Filter by Kanban status column ID. Get valid IDs from fabric_get_project_statuses(projectId). Omit to return features in all statuses.",
				},
				// PASSIVE_ANALYSIS soft-deprecated per spec 2026-05-19-remove-passive-analysis;
				// kept in this public-API enum for backward compatibility (OQ-3 recommended default).
				draftingStage: {
					type: "string",
					enum: [
						"PLACEHOLDER",
						"PASSIVE_ANALYSIS",
						"ACTIVE_ANALYSIS",
						"SANITY_CHECK",
						"DRAFT",
						"PUBLISHED",
						"DECLINED",
						"CLOSED",
					],
					description:
						"Filter by spec readiness stage. Use 'PUBLISHED' for features ready to implement. PLACEHOLDER/DRAFT are incomplete specs.",
				},
				priority: {
					type: "string",
					enum: ["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"],
					description: "Filter by priority (P0_CRITICAL is highest)",
				},
				kind: {
					type: "string",
					enum: ["FEATURE", "BUG"],
					description:
						"Filter by work-item type. Omit to return both features and bugs.",
				},
				search: {
					type: "string",
					description:
						"Search features by title, description, or identifier (e.g. 'F-001')",
				},
				limit: {
					type: "number",
					description: "Max results per page (default 50, max 100)",
					default: 50,
				},
				offset: {
					type: "number",
					description: "Offset for pagination (default 0)",
					default: 0,
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_feature",
		description:
			"Retrieves the complete context for a single feature: title, full description (markdown), acceptance criteria, priority, size, projectId, all tasks with completion status/subtasks/assigned repo+branch, latest PR/coding run URL, and external PM tool link. " +
			"CALL THIS before implementing a feature — it contains everything you need to understand scope and success criteria. " +
			"WARNING: Check the 'draftingStage' field in the response. If it is NOT 'PUBLISHED', the feature spec may be incomplete and should not be implemented yet — confirm with the user before proceeding. " +
			"The returned 'projectId' can be used with fabric_list_documents(projectId) to also fetch the project's PRD, technical spec, or architecture docs for additional context. " +
			"Task 'id' fields → fabric_complete_task. Task 'repositoryUrl'/'targetBranch' fields show where previous coding runs pushed code. " +
			"After implementing, call fabric_update_task with your branch and PR URL to record the implementation. " +
			"This returns the spec as it stands now, with no provenance: call fabric_get_feature_decisions for what was decided and by whom (and what is still an open question), and fabric_get_feature_versions for how the spec got here. " +
			"The 'pmSync' block says whether the linked PM-tool card still reflects this spec — 'autoSyncEnabled' false means the card is a snapshot of the last manual push, not a live mirror, so Fabric is the source of truth.",
		inputSchema: {
			type: "object",
			properties: {
				featureId: {
					type: "string",
					description: "Feature ID from fabric_list_features",
				},
				projectId: {
					type: "string",
					description: "Project ID — required to verify access",
				},
			},
			required: ["featureId", "projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_feature_decisions",
		description:
			"Returns the feature's Decision Log — the threaded record of what was decided about this spec and by whom. " +
			"fabric_get_feature tells you WHAT the spec says; this tells you WHY it says it. " +
			"Each thread is a question root plus its answers, with 'content' reproduced verbatim — quote it, never paraphrase it and call it a decision. " +
			"PROVENANCE IS THE POINT: every entry carries 'source' (HUMAN = a person wrote it, AI_CONFIRMED = the AI proposed it and it was accepted unchallenged) and every answer carries 'answerSource' (MANUAL / AI_EDITED / AI_SUGGESTED). " +
			"A spec whose decisions are all AI_CONFIRMED has not actually been decided by the product side — treat those as drafts and confirm before building on them. " +
			"Threads with status 'OPEN' are unanswered questions and are the scope risk on this feature; check them before estimating. " +
			"Returns an empty list when maturation has never run on the feature.",
		inputSchema: {
			type: "object",
			properties: {
				featureId: {
					type: "string",
					description: "Feature ID from fabric_list_features",
				},
				projectId: {
					type: "string",
					description: "Project ID — required to verify access",
				},
				status: {
					type: "string",
					enum: [
						"OPEN",
						"RESOLVED",
						"REJECTED",
						"FORMATTING_ONLY",
						"POSSIBLY_RESOLVED",
					],
					description:
						"Filter threads by root status. Omit for all. 'OPEN' = still unanswered by the product side.",
				},
			},
			required: ["featureId", "projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_feature_versions",
		description:
			"Returns the feature's revision history — one entry per saved version, newest first, each carrying the change-summary bullets the enhance run emitted describing what it rewrote. " +
			"Use it to see how a spec reached its current state: what the last maturation run changed, when the acceptance criteria last moved, and who moved them. " +
			"Version BODIES ARE OMITTED by default because a mature spec runs to tens of KB per version — pass 'version' to retrieve one revision in full (description, acceptance criteria, and the summary-digest / working-notes snapshots as they stood then). " +
			"Pairs with fabric_get_feature_decisions: versions say what changed, decisions say why.",
		inputSchema: {
			type: "object",
			properties: {
				featureId: {
					type: "string",
					description: "Feature ID from fabric_list_features",
				},
				projectId: {
					type: "string",
					description: "Project ID — required to verify access",
				},
				version: {
					type: "number",
					description:
						"Retrieve this single version in full, including the spec body as it stood at that revision. Omit to list version metadata only.",
				},
				limit: {
					type: "number",
					description: "Max versions per page (default 20, max 50)",
					default: 20,
				},
				offset: {
					type: "number",
					description: "Offset for pagination (default 0)",
					default: 0,
				},
			},
			required: ["featureId", "projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_project_statuses",
		description:
			"Returns all Kanban status columns for a project. Each status has an 'id', 'name' (e.g. 'Backlog', 'In Progress', 'Review', 'Done'), 'color', 'isDefault' (starting column), and 'isFinal' (completion column). " +
			"CALL THIS before fabric_update_feature_status to get the statusId for the column you want to move a feature to. " +
			"Typical workflow progression: Backlog (isDefault=true) → In Progress → Review → Done (isFinal=true).",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Project ID from fabric_list_projects",
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_update_feature_status",
		description:
			"Moves a feature to a different Kanban status column to reflect implementation progress. " +
			"WORKFLOW: (1) Call fabric_get_project_statuses(projectId) to get status IDs and names. " +
			"(2) Move to 'In Progress' when starting implementation. " +
			"(3) Move to 'Review' when implementation is complete and ready for code review. " +
			"(4) Move to the isFinal=true column ('Done') when merged/shipped. " +
			"The featureId comes from fabric_list_features; statusId comes from fabric_get_project_statuses.",
		inputSchema: {
			type: "object",
			properties: {
				featureId: {
					type: "string",
					description: "Feature ID from fabric_list_features",
				},
				projectId: {
					type: "string",
					description:
						"Project ID — required to verify edit permission",
				},
				statusId: {
					type: "string",
					description:
						"Target status column ID from fabric_get_project_statuses. Do NOT pass the status name — pass the id.",
				},
			},
			required: ["featureId", "projectId", "statusId"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_complete_task",
		description:
			"Marks a task within a feature as completed (or reopens it). " +
			"Task IDs are returned by fabric_get_feature in the 'tasks[].id' field. " +
			"Call this after finishing each piece of implementation to track progress. " +
			"Set completed=false to reopen a task if further work is needed.",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
					description: "Task ID from fabric_get_feature tasks[].id",
				},
				projectId: {
					type: "string",
					description: "Project ID — required to verify access",
				},
				completed: {
					type: "boolean",
					description:
						"true to mark the task complete (default), false to reopen it",
					default: true,
				},
			},
			required: ["taskId", "projectId"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_create_feature_task",
		description:
			"Adds a new task to an existing feature. " +
			"Use this to create sub-tasks when you discover implementation work not already captured, or to break down a vague feature into concrete steps before starting. " +
			"The featureId comes from fabric_list_features; projectId is the same project. " +
			"After creating, call fabric_get_feature again to see the updated task list.",
		inputSchema: {
			type: "object",
			properties: {
				featureId: {
					type: "string",
					description: "Feature ID from fabric_list_features",
				},
				projectId: {
					type: "string",
					description:
						"Project ID — required to verify edit permission",
				},
				title: {
					type: "string",
					description:
						"Short, actionable task title (e.g. 'Add input validation to login form')",
				},
				description: {
					type: "string",
					description:
						"Optional detailed description of what needs to be done",
				},
			},
			required: ["featureId", "projectId", "title"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_create_bug",
		description:
			"Files a BUG work item on a project's roadmap. Bugs live alongside features in the same backlog — they get a 'B'-style work-item identifier, appear in fabric_list_features (filter kind='BUG'), and are drafted through the project's bug template, so a short factual report is enough. " +
			"BUILT FOR AUTONOMOUS MONITORING: this tool is safe to call every time you observe a failure. It will NOT pile up duplicates, because it runs two dedup layers before creating anything. " +
			"A DEDUP HIT IS SUCCESS, NOT AN ERROR — the response is always success-shaped with a 'created' boolean. When created=false you still get the 'id' and 'identifier' of the bug that already covers this failure, plus 'dedupedBy' telling you which layer matched. Treat that as 'already filed', add your new evidence as a comment or an update if it matters, and do NOT retry with a tweaked title to force a second row. " +
			"ALWAYS SEND A 'fingerprint'. It is the only reliable dedup key. Title matching is best-effort and WILL eventually miss, because the bug is drafted through the project's bug template, which may rewrite the stored title into something your next report no longer matches. If you cannot compute a fingerprint, expect occasional duplicates. " +
			"LAYER 1 — fingerprint (exact, reliable). Pass 'fingerprint': a stable key you derive from the underlying error itself, e.g. a hash of the normalized stack top + exception type + failing route, with volatile parts (timestamps, request IDs, memory addresses, row counts) stripped. Send the SAME value on every sighting. If an OPEN bug in this project already carries that fingerprint, it is returned unchanged and dedupedBy='fingerprint'. This is exact and title-independent, so it survives both you and Fabric rewording the report. A bug that was CLOSED or DECLINED does not block a new filing: a regression after a fix is a new bug, and it will get a new row. " +
			"LAYER 2 — title (best-effort). Even with no fingerprint, the title is matched (normalized, case- and punctuation-insensitive) against the project's open bugs. A match returns that bug with dedupedBy='title'. Bug titles are only ever matched against other bugs, never against features. When a title match happens AND you supplied a fingerprint that the matched bug does not yet have, your fingerprint is attached to it (the response sets fingerprintAttached=true) so every later sighting hits layer 1 instead. " +
			"WRITING THE REPORT: put the failure in 'title' as a short specific symptom ('Checkout returns 500 when cart is empty'), not a category ('bug in checkout'). Put everything you observed in 'description' — error message, stack trace, the request or job that triggered it, environment, frequency, first-seen time. That text is fed to the project's bug-drafting prompt, so more detail produces a more actionable card. " +
			"Get 'projectId' from fabric_list_projects. The project must belong to your session's ACTIVE context — call fabric_switch_organization first if it lives in another organization (or in your personal space). Requires permission to create work items in the project. " +
			"Inputs are validated strictly: an unrecognised 'priority' is rejected rather than quietly downgraded, so read the error and resend with a valid value.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description:
						"Project ID from fabric_list_projects. Must be in your session's active organization (or personal context).",
				},
				title: {
					type: "string",
					description:
						"Short, specific symptom line (e.g. 'Checkout returns 500 when cart is empty'). Avoid vague category titles — this is also the layer-2 dedup key. Max 500 characters.",
				},
				description: {
					type: "string",
					description:
						"Everything you observed: error message, stack trace, triggering request/job, environment, frequency, first-seen time. Fed to the project's bug-drafting prompt. Max 50000 characters — send the relevant frames, not a whole log file.",
				},
				fingerprint: {
					type: "string",
					description:
						"STRONGLY RECOMMENDED — the only reliable dedup key. A stable key for the underlying error, e.g. a hash of the normalized error signature (exception type + stack top + failing route), with timestamps, IDs and other volatile parts stripped. Send the SAME value on every sighting of the same error. Max 200 characters.",
				},
				priority: {
					type: "string",
					enum: ["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"],
					description:
						"Severity band (P0_CRITICAL is highest). Defaults to P2_MEDIUM when omitted. An unrecognised value is an error, NOT a silent downgrade — send one of the four exact strings.",
				},
			},
			required: ["projectId", "title"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_create_feature",
		description:
			"Files a FEATURE work item on a project's roadmap. Features are the default work-item type: they get an 'F'-style work-item identifier, appear in fabric_list_features (filter kind='FEATURE'), and land in the project's default backlog status. " +
			"THE PROJECT WRITES THE DETAIL. The item is created as a placeholder and drafted through the project's feature-drafting prompt, so a one-line request plus whatever context you have is enough — you do NOT need to author a spec, a template, or acceptance criteria. " +
			"FILE ONLY WHAT WAS ACTUALLY ASKED FOR. Create a feature when a person has requested the capability or agreed a follow-up is worth tracking. Do NOT create one speculatively, to record an idea you had, or to split work you are about to do anyway — an unwanted feature has to be triaged and closed by a human. " +
			"A TITLE COLLISION IS SUCCESS, NOT AN ERROR. Before creating anything, your title is matched (normalized, case- and punctuation-insensitive) against the project's other open features. On a match nothing is created and the response is still success-shaped: 'created' is false, 'dedupedBy' is 'title', and 'id' / 'identifier' point at the item that already covers this request. Treat that as 'already tracked'. If you have information the existing item does not cover, attach it with fabric_create_feature_task or raise it with whoever asked — do NOT resend with a reworded title to force a second row. Feature titles are only ever matched against other features, never against bugs, and a CLOSED or DECLINED item does not block a new filing. " +
			"WRITING THE REQUEST: put a short capability statement in 'title' ('Export the roadmap as CSV'), not a vague area ('reporting') — it is also the dedup key. Put the request and its context in 'description': who asked, the problem it solves, constraints, links to the conversation. That text is fed to the drafting prompt, so more context produces a more actionable card. " +
			"Get 'projectId' from fabric_list_projects. The project must belong to your session's ACTIVE context — call fabric_switch_organization first if it lives in another organization (or in your personal space). Requires permission to create work items in the project. " +
			"Inputs are validated strictly: an unrecognised 'priority' or 'size' is rejected rather than quietly defaulted, so read the error and resend with a valid value.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description:
						"Project ID from fabric_list_projects. Must be in your session's active organization (or personal context).",
				},
				title: {
					type: "string",
					description:
						"Short capability statement (e.g. 'Export the roadmap as CSV'). Avoid vague area titles — this is also the dedup key. Max 500 characters.",
				},
				description: {
					type: "string",
					description:
						"The request and its context: who asked, the problem it solves, constraints, links. Fed to the project's feature-drafting prompt. Max 50000 characters — context, not a pasted design doc.",
				},
				priority: {
					type: "string",
					enum: ["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"],
					description:
						"Priority band (P0_CRITICAL is highest). Defaults to P2_MEDIUM when omitted. An unrecognised value is an error, NOT a silent default — send one of the four exact strings.",
				},
				size: {
					type: "string",
					enum: ["XS", "S", "M", "L", "XL"],
					description:
						"Optional t-shirt size estimate. Omit it unless you have a real basis for the estimate — a guess here is worse than no value.",
				},
			},
			required: ["projectId", "title"],
		},
		_gateway_source: "platform",
	},

	{
		name: "fabric_update_task",
		description:
			"Updates a task's details. Use this to record implementation metadata back onto the task after completing work: set the repositoryUrl, targetBranch, and a description with the PR link. " +
			"This closes the feedback loop so teammates and future agents can see exactly where each task was implemented. " +
			"Task IDs come from fabric_get_feature tasks[].id. " +
			"You can also update the title or estimated hours, or mark isCompleted=true (same as fabric_complete_task).",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
					description: "Task ID from fabric_get_feature tasks[].id",
				},
				projectId: {
					type: "string",
					description: "Project ID — required to verify access",
				},
				title: {
					type: "string",
					description: "Updated task title",
				},
				description: {
					type: "string",
					description:
						"Implementation notes, e.g. 'Implemented in PR #42 — added input validation in auth/login.ts'",
				},
				isCompleted: {
					type: "boolean",
					description: "Mark task complete (true) or reopen (false)",
				},
				repositoryUrl: {
					type: "string",
					description:
						"Full GitHub/GitLab repo URL where this task was implemented, e.g. 'https://github.com/org/repo'",
				},
				targetBranch: {
					type: "string",
					description:
						"Branch where implementation was pushed, e.g. 'feat/login-validation'",
				},
			},
			required: ["taskId", "projectId"],
		},
		_gateway_source: "platform",
	},

	// ── Documents ──
	{
		name: "fabric_list_documents",
		description:
			"Lists documents attached to a project (PRDs, Technical Specs, Architecture docs, API Specs, etc.). " +
			"Returns document IDs, titles, types, and status. " +
			"Use the returned 'id' as 'documentId' in fabric_get_document to read full content. " +
			"CONTEXT FOR CODING AGENTS: After fabric_get_feature, call this with the same projectId to find PRD (type='PRD') and technical spec (type='TECHNICAL_SPEC') documents that describe the broader system context and design decisions. " +
			"Filter by type to find only the relevant document category.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Project ID from fabric_list_projects",
				},
				type: {
					type: "string",
					enum: [
						"GENERAL",
						"PRD",
						"PROPOSAL",
						"BUSINESS_CASE",
						"ARCHITECTURE",
						"TECHNICAL_SPEC",
						"USER_STORY",
						"API_SPEC",
						"QA_STRATEGY",
					],
					description:
						"Filter by document type. Omit to list all. For implementation context, use 'PRD', 'TECHNICAL_SPEC', or 'ARCHITECTURE'.",
				},
				limit: {
					type: "number",
					description: "Max results per page (default 20)",
					default: 20,
				},
				offset: {
					type: "number",
					description: "Offset for pagination (default 0)",
					default: 0,
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_document",
		description:
			"Retrieves the full markdown content of a project document, including title, type, version number, and the complete body text. " +
			"Get the documentId from fabric_list_documents(projectId). " +
			"Use this to read a PRD (type='PRD') for product requirements, a technical spec (type='TECHNICAL_SPEC') for implementation details, or an architecture doc (type='ARCHITECTURE') for system design. " +
			"These documents provide the broader context that informs how features should be implemented.",
		inputSchema: {
			type: "object",
			properties: {
				documentId: {
					type: "string",
					description: "Document ID from fabric_list_documents",
				},
			},
			required: ["documentId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_create_document",
		description:
			"Creates a new document in a project (PRD, Technical Spec, Architecture doc, API Spec, etc.). " +
			"Use this to document implementation decisions, create a technical spec for a feature, or record API design. " +
			"The projectId comes from fabric_list_projects. " +
			"Content should be markdown. Status defaults to 'DRAFT' — set to 'ACTIVE' if immediately publishing. " +
			"After creating, the returned documentId can be used with fabric_get_document or fabric_update_document.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Project ID from fabric_list_projects",
				},
				type: {
					type: "string",
					enum: [
						"GENERAL",
						"PRD",
						"PROPOSAL",
						"BUSINESS_CASE",
						"ARCHITECTURE",
						"TECHNICAL_SPEC",
						"USER_STORY",
						"API_SPEC",
						"QA_STRATEGY",
					],
					description:
						"Document type. Use 'TECHNICAL_SPEC' for implementation notes, 'API_SPEC' for API design, 'ARCHITECTURE' for system diagrams/decisions.",
				},
				title: {
					type: "string",
					description: "Document title",
				},
				content: {
					type: "string",
					description: "Document body in markdown format",
				},
				status: {
					type: "string",
					enum: ["DRAFT", "IN_PROGRESS", "REVIEW", "COMPLETE"],
					description:
						"Initial status (default: 'DRAFT'). Use 'IN_PROGRESS' while writing, 'REVIEW' when ready for review, 'COMPLETE' when finalized.",
				},
			},
			required: ["projectId", "type", "title", "content"],
		},
		annotations: { destructiveHint: false },
		_gateway_source: "platform",
	},
	{
		name: "fabric_update_document",
		description:
			"Updates an existing project document's title, content, or status. Each content update creates a version snapshot for history. " +
			"Get the documentId from fabric_list_documents(projectId). " +
			"Provide only the fields you want to change — omitted fields are left unchanged. " +
			"Use this to update implementation notes after a coding run, append PR links to a technical spec, or move a DRAFT document to COMPLETE.",
		inputSchema: {
			type: "object",
			properties: {
				documentId: {
					type: "string",
					description: "Document ID from fabric_list_documents",
				},
				title: {
					type: "string",
					description: "New document title",
				},
				content: {
					type: "string",
					description:
						"New document body in markdown. Replaces the entire content and bumps the version number.",
				},
				status: {
					type: "string",
					enum: ["DRAFT", "IN_PROGRESS", "REVIEW", "COMPLETE"],
					description:
						"New document status. Progress: DRAFT → IN_PROGRESS → REVIEW → COMPLETE.",
				},
				changeDescription: {
					type: "string",
					description:
						"Brief description of what changed, e.g. 'Added implementation notes for auth module'. Stored in version history.",
				},
			},
			required: ["documentId"],
		},
		_gateway_source: "platform",
	},

	// ── Project Context ──
	{
		name: "fabric_list_project_contexts",
		description:
			"Lists the source material attached to a project's Context tab: uploaded files (PDF, DOCX, images, spreadsheets), meeting transcripts, crawled links, pasted notes, and connected-integration sources. " +
			"This is the same inventory the Context tab's 'Download All' export covers — use it when you need the raw research material behind a project, not its authored documents (fabric_list_documents) or its backlog (fabric_list_features). " +
			"Returns lightweight summaries only, never bodies: read one with fabric_get_project_context using the returned 'id'. " +
			"'contentAvailable': false means there is no text to read — check 'unavailableReason' before assuming the source was empty. " +
			"Repository code-index entries (CODE_FILE, CODE_FILE_SUMMARY) are excluded by default because an indexed repo produces thousands of them; 'excludedCodeContexts' reports how many were hidden.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "Project ID from fabric_list_projects",
				},
				type: {
					type: "string",
					enum: [
						"FILE",
						"IMAGE",
						"DOCUMENT",
						"SPREADSHEET",
						"LINK",
						"TEXT",
						"INTEGRATION",
						"MEETING_TRANSCRIPT",
						"SLACK_HUDDLE_NOTES",
						"CODE_FILE",
						"CODE_FILE_SUMMARY",
						"TECH_STACK",
						"FEATURES",
						"GOALS",
						"DESCRIPTION",
						"ARCHITECTURE_DECISION",
						"TEST_CASE",
					],
					description:
						"Filter to one source type. Use 'MEETING_TRANSCRIPT' for synced meeting transcripts, 'FILE'/'DOCUMENT'/'SPREADSHEET'/'IMAGE' for uploads, 'LINK' for crawled URL sources. Passing 'CODE_FILE' or 'CODE_FILE_SUMMARY' explicitly overrides the code-index exclusion.",
				},
				includeCodeContexts: {
					type: "boolean",
					description:
						"Include repository code-index entries in an unfiltered listing (default false). There are usually thousands — prefer filtering by type instead.",
					default: false,
				},
				limit: {
					type: "number",
					description: "Max results per page (default 50, max 200)",
					default: 50,
				},
				offset: {
					type: "number",
					description: "Offset for pagination (default 0)",
					default: 0,
				},
			},
			required: ["projectId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_project_context",
		description:
			"Reads one project context source in full: the transcript text of a meeting, the extracted text of an uploaded PDF/DOCX/spreadsheet, the crawled markdown of a link, a pasted note, or the conversation captured from a monitored Teams/Slack channel. " +
			"Get the contextId from fabric_list_project_contexts. " +
			"Long bodies are paged, never silently cut: when 'truncated' is true, call again with 'offset' set to 'nextOffset' to continue. " +
			"For uploaded files the response also carries 'originalFile.url' — a short-lived link to the original binary, for cases where the extracted text is not enough (an image, a diagram-heavy PDF). " +
			"If 'contentAvailable' is false, read 'unavailableReason': a monitored Teams or Slack conversation, for example, keeps its captured messages apart from the context row, so an empty body does not mean an empty conversation.",
		inputSchema: {
			type: "object",
			properties: {
				contextId: {
					type: "string",
					description: "Context ID from fabric_list_project_contexts",
				},
				offset: {
					type: "number",
					description:
						"Character offset to start reading from (default 0). Use 'nextOffset' from a truncated response.",
					default: 0,
				},
				maxLength: {
					type: "number",
					description:
						"Max characters of body text to return in this call (default 50000, max 200000)",
					default: 50000,
				},
			},
			required: ["contextId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},

	// ── Workspaces (RAG Knowledge Bases) ──
	{
		name: "fabric_list_workspaces",
		description:
			"Lists RAG knowledge bases the user has access to. Workspaces are separate from projects — they contain indexed documents for semantic search across large corpora. " +
			"Use workspaces when you need to search across many documents rather than read a specific one. " +
			"Returns workspace IDs needed for fabric_query_workspace and fabric_get_workspace.",
		inputSchema: {
			type: "object",
			properties: {
				search: {
					type: "string",
					description: "Filter workspaces by name",
				},
				limit: {
					type: "number",
					description: "Max results per page (default 20)",
					default: 20,
				},
				offset: {
					type: "number",
					description: "Offset for pagination (default 0)",
					default: 0,
				},
			},
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_workspace",
		description:
			"Retrieves details of a workspace (knowledge base): name, description, and list of indexed documents. " +
			"Use the workspaceId from fabric_list_workspaces. " +
			"To search across workspace content, use fabric_query_workspace instead.",
		inputSchema: {
			type: "object",
			properties: {
				workspaceId: {
					type: "string",
					description: "Workspace ID from fabric_list_workspaces",
				},
			},
			required: ["workspaceId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_query_workspace",
		description:
			"Performs semantic (RAG) search across all documents in a workspace. Returns the most relevant chunks with similarity scores. " +
			"Use this when you need to find specific information across a large knowledge base rather than reading entire documents. " +
			"Get the workspaceId from fabric_list_workspaces. " +
			"Example queries: 'authentication flow', 'database schema for users', 'API rate limiting policy'.",
		inputSchema: {
			type: "object",
			properties: {
				workspaceId: {
					type: "string",
					description: "Workspace ID from fabric_list_workspaces",
				},
				query: {
					type: "string",
					description:
						"Natural language search query describing the information you need",
				},
				limit: {
					type: "number",
					description:
						"Max result chunks to return (default 10, max 50)",
					default: 10,
				},
			},
			required: ["workspaceId", "query"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},

	// ── Workflows ──
	{
		name: "fabric_list_workflows",
		description:
			"Lists automation workflows in the current context. Returns workflow IDs, names, status (DRAFT/ACTIVE/PAUSED/ARCHIVED), and trigger type. " +
			"Use workflow IDs with fabric_get_workflow and fabric_execute_workflow.",
		inputSchema: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"],
					description:
						"Filter by workflow status. Omit to return all.",
				},
				search: {
					type: "string",
					description: "Search workflows by name",
				},
				limit: {
					type: "number",
					description: "Max results per page (default 20)",
					default: 20,
				},
				offset: {
					type: "number",
					description: "Offset for pagination (default 0)",
					default: 0,
				},
			},
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_workflow",
		description:
			"Retrieves a workflow's full definition: nodes, edges, trigger configuration, and recent execution history. " +
			"Use the workflowId from fabric_list_workflows. " +
			"Call fabric_execute_workflow to run it.",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: {
					type: "string",
					description: "Workflow ID from fabric_list_workflows",
				},
			},
			required: ["workflowId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_execute_workflow",
		description:
			"Triggers a published (status='ACTIVE') workflow. Returns an executionId for tracking. " +
			"Poll fabric_get_workflow_execution(executionId) to check completion status and results. " +
			"The workflowId comes from fabric_list_workflows.",
		inputSchema: {
			type: "object",
			properties: {
				workflowId: {
					type: "string",
					description:
						"Workflow ID from fabric_list_workflows (must be ACTIVE)",
				},
				inputs: {
					type: "object",
					description:
						"Key-value input parameters required by the workflow (check fabric_get_workflow for expected inputs)",
				},
			},
			required: ["workflowId"],
		},
		annotations: { destructiveHint: false },
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_workflow_execution",
		description:
			"Checks the status and results of a workflow execution. " +
			"Use the executionId returned by fabric_execute_workflow. " +
			"Poll this until status is 'COMPLETED' or 'FAILED'.",
		inputSchema: {
			type: "object",
			properties: {
				executionId: {
					type: "string",
					description: "Execution ID from fabric_execute_workflow",
				},
			},
			required: ["executionId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},

	// ── AI Chats ──
	{
		name: "fabric_list_chats",
		description:
			"Lists recent AI chat conversations for the current user in the active context. " +
			"Returns chat IDs, titles, and timestamps. Useful for reviewing past AI interactions related to a project.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Max results to return (default 20)",
					default: 20,
				},
			},
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},

	// ── Frames ──
	{
		name: "fabric_create_frame",
		description:
			"Creates a shareable visual artifact (Frame) in the current context. Frames are rich interactive cards that can contain HTML, Mermaid diagrams, markdown, or JSON data. " +
			"Use this to create visualizations, diagrams, status boards, or rich-text reports that can be shared with teammates. " +
			"Set shareOnCreate=true to immediately get a public share URL in the response. " +
			"After creating, call fabric_share_frame(frameId) to get the share URL, or fabric_update_frame(frameId) to modify content. " +
			"Use 'mermaid' format for flowcharts/sequence diagrams, 'html' for rich layouts, 'markdown' for formatted text.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Frame title",
				},
				description: {
					type: "string",
					description: "Optional description shown below the title",
				},
				components: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description: "Unique block ID",
							},
							type: {
								type: "string",
								enum: ["html", "json", "mermaid", "markdown"],
								description: "Content format of this block",
							},
							title: {
								type: "string",
								description: "Optional block title",
							},
							content: {
								type: "string",
								description: "Block content",
							},
							language: {
								type: "string",
								description: "Optional language hint",
							},
						},
						required: ["id", "type", "content"],
					},
					description:
						"Array of content blocks/components for the frame",
				},
				format: {
					type: "string",
					enum: ["html", "json", "mermaid", "markdown"],
					default: "html",
					description:
						"Content format: 'html' for rich layouts, 'mermaid' for diagrams, 'markdown' for text, 'json' for structured data",
				},
				kind: {
					type: "string",
					enum: ["frame", "slideshow"],
					default: "frame",
					description:
						"'frame' for a single-page artifact, 'slideshow' for a multi-slide presentation",
				},
				shareOnCreate: {
					type: "boolean",
					description:
						"If true, immediately publish the frame and return a share URL in the response",
				},
			},
			required: ["title"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_update_frame",
		description:
			"Updates an existing Frame's title, description, or content blocks. " +
			"Get the frameId from fabric_list_frames or from the response of fabric_create_frame. " +
			"Provide only the fields you want to change — omitted fields are unchanged.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: {
					type: "string",
					description:
						"Frame ID from fabric_list_frames or fabric_create_frame",
				},
				title: {
					type: "string",
					description: "New frame title",
				},
				description: {
					type: "string",
					description: "New description",
				},
				blocks: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description: "Unique block ID",
							},
							type: {
								type: "string",
								enum: ["html", "json", "mermaid", "markdown"],
								description: "Content format of this block",
							},
							title: {
								type: "string",
								description: "Optional block title",
							},
							content: {
								type: "string",
								description: "Block content",
							},
							language: {
								type: "string",
								description: "Optional language hint",
							},
						},
						required: ["id", "type", "content"],
					},
					description: "Replacement content blocks",
				},
			},
			required: ["frameId"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_get_frame",
		description:
			"Retrieves a Frame by ID, including its full content blocks, format, and share URL (if published). " +
			"Get the frameId from fabric_list_frames. " +
			"Use fabric_share_frame(frameId) to publish and get a shareable URL if not already shared.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: {
					type: "string",
					description: "Frame ID from fabric_list_frames",
				},
			},
			required: ["frameId"],
		},
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_list_frames",
		description:
			"Lists all Frames in the current context (personal or organization). Returns frame IDs, titles, formats, and share status. " +
			"Use the returned 'id' field as 'frameId' in fabric_get_frame, fabric_update_frame, or fabric_share_frame.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
	{
		name: "fabric_share_frame",
		description:
			"Publishes a Frame and returns its public share URL. Once shared, anyone with the link can view the frame. " +
			"Get the frameId from fabric_list_frames or fabric_create_frame. " +
			"Returns the shareUrl to share with teammates or embed in external tools.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: {
					type: "string",
					description:
						"Frame ID from fabric_list_frames or fabric_create_frame",
				},
			},
			required: ["frameId"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_create_slideshow",
		description:
			"Creates a multi-slide presentation artifact (Slideshow) in the current context. Slideshows are ideal for structured presentations, feature demos, or step-by-step walkthroughs. " +
			"Each component in the 'components' array becomes a separate slide. " +
			"Set shareOnCreate=true to immediately get a public share URL. " +
			"After creating, call fabric_share_frame(frameId) to get the share URL.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Slideshow title",
				},
				description: {
					type: "string",
					description: "Optional description",
				},
				components: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description: "Unique slide ID",
							},
							type: {
								type: "string",
								enum: ["html", "json", "mermaid", "markdown"],
								description: "Content format of this slide",
							},
							title: {
								type: "string",
								description: "Optional slide title",
							},
							content: {
								type: "string",
								description: "Slide content",
							},
							language: {
								type: "string",
								description: "Optional language hint",
							},
						},
						required: ["id", "type", "content"],
					},
					description:
						"Array of slide content objects — each entry becomes one slide",
				},
				format: {
					type: "string",
					enum: ["html", "json", "mermaid", "markdown"],
					default: "html",
					description: "Content format for slides",
				},
				shareOnCreate: {
					type: "boolean",
					description:
						"If true, immediately publish and return a share URL",
				},
			},
			required: ["title"],
		},
		_gateway_source: "platform",
	},

	// ── Connected MCP Servers ──
	{
		name: "fabric_list_connected_servers",
		description:
			"Lists all MCP servers the user has connected in the current context (personal or organization). Returns server names, provider keys, status, and available tool count. " +
			"Use the 'providerKey' values from this response as input to fabric_request_authority when you need runtime access to external tools on those servers. " +
			"Example: if a server has providerKey='linear', pass providerKey='linear' to fabric_request_authority to request access.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},

	// ── Runtime Authority ──
	{
		name: "fabric_request_authority",
		description:
			"Request runtime authority to use connected external systems. Authority is time-limited and must be approved before tools can be executed. " +
			"Specify which providers you need access to and at what level (READ or WRITE). " +
			"Returns a pending authority session that must be approved by a human in the Fabric UI or API.",
		inputSchema: {
			type: "object",
			properties: {
				providers: {
					type: "array",
					description: "List of providers to request authority for",
					items: {
						type: "object",
						properties: {
							providerKey: {
								type: "string",
								description:
									'Normalized provider key (e.g., "github", "linear", "slack") or "custom:<server-name>"',
							},
							accessLevel: {
								type: "string",
								enum: ["READ", "WRITE"],
								description: "Required access level",
							},
							reason: {
								type: "string",
								description: "Why this access is needed",
							},
						},
						required: ["providerKey", "accessLevel"],
					},
				},
				ttlMinutes: {
					type: "number",
					description:
						"How long authority should last (default: 30, max: 480)",
					default: 30,
				},
			},
			required: ["providers"],
		},
		_gateway_source: "platform",
	},
	// NOTE: fabric_approve_authority is intentionally NOT exposed as an MCP tool.
	// Approval must happen through the Fabric UI or API to ensure human-in-the-loop.
	// Agents can request authority (fabric_request_authority) and check status
	// (fabric_check_authority), but only humans can approve via the UI.
	{
		name: "fabric_revoke_authority",
		description:
			"Revoke an active authority session, immediately ending all granted permissions.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Authority session ID to revoke",
				},
			},
			required: ["sessionId"],
		},
		_gateway_source: "platform",
	},
	{
		name: "fabric_check_authority",
		description:
			"Check current authority status. Returns active authority sessions and grants for the current context.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		_gateway_source: "platform",
	},
];

// ─── Tool Handlers ──────────────────────────────────────────────────────────

/**
 * Execute a platform tool by name.
 * All DB imports are dynamic to avoid pulling Prisma into the module scope.
 */
export async function executePlatformTool(
	toolName: string,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	try {
		switch (toolName) {
			case "fabric_get_identity":
				return await handleGetIdentity(session);
			case "fabric_list_organizations":
				return await handleListOrganizations(session);
			case "fabric_switch_organization":
				return await handleSwitchOrganization(args, session);
			case "fabric_list_projects":
				return await handleListProjects(args, session);
			case "fabric_get_project":
				return await handleGetProject(args, session);
			case "fabric_create_project":
				return await handleCreateProject(args, session);
			case "fabric_update_project":
				return await handleUpdateProject(args, session);
			case "fabric_list_features":
				return await handleListFeatures(args, session);
			case "fabric_get_feature":
				return await handleGetFeature(args, session);
			case "fabric_get_feature_decisions":
				return await handleGetFeatureDecisions(args, session);
			case "fabric_get_feature_versions":
				return await handleGetFeatureVersions(args, session);
			case "fabric_get_project_statuses":
				return await handleGetProjectStatuses(args, session);
			case "fabric_update_feature_status":
				return await handleUpdateFeatureStatus(args, session);
			case "fabric_complete_task":
				return await handleCompleteTask(args, session);
			case "fabric_create_feature_task":
				return await handleCreateFeatureTask(args, session);
			case "fabric_create_bug":
				return await handleCreateBug(args, session);
			case "fabric_create_feature":
				return await handleCreateFeature(args, session);
			case "fabric_update_task":
				return await handleUpdateTask(args, session);
			case "fabric_list_documents":
				return await handleListDocuments(args, session);
			case "fabric_get_document":
				return await handleGetDocument(args, session);
			case "fabric_create_document":
				return await handleCreateDocument(args, session);
			case "fabric_update_document":
				return await handleUpdateDocument(args, session);
			case "fabric_list_project_contexts":
				return await handleListProjectContexts(args, session);
			case "fabric_get_project_context":
				return await handleGetProjectContext(args, session);
			case "fabric_list_workspaces":
				return await handleListWorkspaces(args, session);
			case "fabric_get_workspace":
				return await handleGetWorkspace(args, session);
			case "fabric_query_workspace":
				return await handleQueryWorkspace(args, session);
			case "fabric_list_workflows":
				return await handleListWorkflows(args, session);
			case "fabric_get_workflow":
				return await handleGetWorkflow(args, session);
			case "fabric_execute_workflow":
				return await handleExecuteWorkflow(args, session);
			case "fabric_get_workflow_execution":
				return await handleGetWorkflowExecution(args, session);
			case "fabric_list_chats":
				return await handleListChats(args, session);
			case "fabric_create_frame":
				return await handleCreateFrame(args, session);
			case "fabric_update_frame":
				return await handleUpdateFrame(args, session);
			case "fabric_get_frame":
				return await handleGetFrame(args, session);
			case "fabric_list_frames":
				return await handleListFrames(session);
			case "fabric_share_frame":
				return await handleShareFrame(args, session);
			case "fabric_create_slideshow":
				return await handleCreateSlideshow(args, session);
			case "fabric_list_connected_servers":
				return await handleListConnectedServers(session);
			case "fabric_request_authority":
				return await handleRequestAuthority(args, session);
			// fabric_approve_authority is not an MCP tool — approval is human-only via Fabric UI/API
			case "fabric_revoke_authority":
				return await handleRevokeAuthority(args, session);
			case "fabric_check_authority":
				return await handleCheckAuthority(session);
			default:
				return errorResult(`Unknown platform tool: ${toolName}`);
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Internal error";
		console.error(`[MCP Gateway] Platform tool ${toolName} error:`, error);
		return errorResult(message);
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResult(data: unknown): ToolCallResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(message: string): ToolCallResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: message }) }],
		isError: true,
	};
}

/**
 * Build XOR tenant filter. Returns a discriminated union rather than a widened
 * `organizationId: string | null` so it satisfies query helpers that type their
 * tenant argument as the union (e.g. `listDecisionLogThreads`).
 */
function tenantFilter(session: GatewaySession) {
	return session.organizationId
		? { organizationId: session.organizationId, userId: session.userId }
		: { organizationId: null, userId: session.userId };
}

// ─── Identity Handlers ──────────────────────────────────────────────────────

async function handleGetIdentity(
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { db } = await import("@repo/database");

	const memberships = await db.member.findMany({
		where: { userId: session.userId },
		include: {
			organization: { select: { id: true, name: true, slug: true } },
		},
	});

	const organizations = memberships.map((m) => ({
		id: m.organization.id,
		name: m.organization.name,
		slug: m.organization.slug,
		role: m.role,
	}));

	return jsonResult({
		userId: session.userId,
		userName: session.userName,
		email: session.email,
		role: session.role,
		organizationId: session.organizationId,
		organizationName: session.organizationId
			? (organizations.find((o) => o.id === session.organizationId)
					?.name ?? null)
			: null,
		mode: session.organizationId ? "organization" : "personal",
		organizations,
	});
}

async function handleListOrganizations(
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { db } = await import("@repo/database");

	const memberships = await db.member.findMany({
		where: { userId: session.userId },
		include: {
			organization: { select: { id: true, name: true, slug: true } },
		},
	});

	const organizations = memberships.map((m) => ({
		id: m.organization.id,
		name: m.organization.name,
		slug: m.organization.slug,
		role: m.role,
	}));

	return jsonResult({
		organizations,
		count: organizations.length,
		activeOrganizationId: session.organizationId,
	});
}

async function handleSwitchOrganization(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const organizationId = (args.organizationId as string | null) ?? null;

	if (organizationId) {
		const { db } = await import("@repo/database");
		const membership = await db.member.findFirst({
			where: { userId: session.userId, organizationId },
		});
		if (!membership) {
			return errorResult(
				`Access denied: you are not a member of organization ${organizationId}`,
			);
		}
	}

	// Update the session — the caller (gateway route) will persist this
	const previousOrgId = session.organizationId;
	session.organizationId = organizationId;

	return jsonResult({
		success: true,
		previousOrganizationId: previousOrgId,
		newOrganizationId: organizationId,
		mode: organizationId ? "organization" : "personal",
	});
}

// ─── Project Handlers ───────────────────────────────────────────────────────

async function handleListProjects(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listProjects } = await import("@repo/database");

	const result = await listProjects({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		status: args.status as "ACTIVE" | "ARCHIVED" | "COMPLETED" | undefined,
		search: args.search as string | undefined,
		limit: Math.min((args.limit as number) ?? 20, 50),
		offset: (args.offset as number) ?? 0,
	});

	return jsonResult({
		projects: result.projects.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
			status: p.status,
			heroEmojis: p.heroEmojis,
			createdAt: p.createdAt,
			updatedAt: p.updatedAt,
		})),
		total: result.total,
		hasMore: result.hasMore,
	});
}

async function handleGetProject(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getProjectSummaryById } = await import("@repo/database");

	const projectId = args.projectId as string;
	if (!projectId) {
		return errorResult("projectId is required");
	}

	// getProjectById enforces tenant isolation via userId + organizationId
	const project = await getProjectSummaryById(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!project) {
		return errorResult("Project not found or access denied");
	}

	return jsonResult({
		id: project.id,
		name: project.name,
		description: project.description,
		status: project.status,
		heroEmojis: project.heroEmojis,
		createdAt: project.createdAt,
		updatedAt: project.updatedAt,
	});
}

async function handleCreateProject(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createProject } = await import("@repo/database");

	const name = args.name as string;
	if (!name) {
		return errorResult("name is required");
	}

	const project = await createProject({
		name,
		description: (args.description as string) ?? undefined,
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});

	return jsonResult({
		id: project.id,
		name: project.name,
		message: `Project "${project.name}" created successfully`,
	});
}

async function handleUpdateProject(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { updateProject, canEditProject } = await import("@repo/database");

	const projectId = args.projectId as string;
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const canEdit = await canEditProject(projectId, session.userId);
	if (!canEdit) {
		return errorResult("No edit permission for this project");
	}

	const updated = await updateProject(projectId, session.userId, {
		...(args.name ? { name: args.name as string } : {}),
		...(args.description !== undefined
			? { description: args.description as string }
			: {}),
	});

	return jsonResult({
		id: updated.id,
		name: updated.name,
		message: `Project "${updated.name}" updated successfully`,
	});
}

// ─── Feature (Story) Handlers ───────────────────────────────────────────────

async function handleListFeatures(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listStories, hasProjectAccess } = await import("@repo/database");

	if (typeof args.projectId !== "string" || !args.projectId.trim()) {
		return errorResult(
			"projectId is required and must be a non-empty string — get one from fabric_list_projects",
		);
	}
	const projectId = args.projectId.trim();

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	// Validate before this reaches Prisma: the gateway routes pass `arguments`
	// through unvalidated, and an unrecognised enum value would surface as a
	// raw Prisma validation error rather than something an agent can act on.
	// (This handler needs no tenant-context check of its own beyond
	// hasProjectAccess — it is a read whose every row is already scoped by
	// `projectId`, so a cross-org session cannot widen what it returns. The
	// pre-existing gap in hasProjectAccess is noted on handleCreateBug.)
	if (
		args.kind !== undefined &&
		!STORY_KINDS.includes(args.kind as StoryKindValue)
	) {
		return errorResult(
			`kind must be one of ${STORY_KINDS.join(", ")} (received ${JSON.stringify(args.kind)}). Omit it to return both.`,
		);
	}

	const limit = Math.min((args.limit as number) ?? 50, 100);
	const offset = (args.offset as number) ?? 0;

	const { stories, total } = await listStories({
		projectId,
		statusId: args.statusId as string | undefined,
		draftingStage: args.draftingStage as
			| "PLACEHOLDER"
			| "PASSIVE_ANALYSIS"
			| "ACTIVE_ANALYSIS"
			| "SANITY_CHECK"
			| "DRAFT"
			| "PUBLISHED"
			| "DECLINED"
			| "CLOSED"
			| undefined,
		priority: args.priority as
			| "P0_CRITICAL"
			| "P1_HIGH"
			| "P2_MEDIUM"
			| "P3_LOW"
			| undefined,
		// Omitted => both features and bugs, which is what this tool has always
		// returned; the filter only makes the split addressable.
		kind: args.kind as StoryKindValue | undefined,
		search: args.search as string | undefined,
		limit,
		offset,
		includeTaskCount: true,
	});

	return jsonResult({
		features: stories.map((s) => ({
			id: s.id,
			identifier: s.identifier,
			title: s.title,
			kind: s.kind,
			status: {
				id: s.status.id,
				name: s.status.name,
				color: s.status.color,
			},
			priority: s.priority,
			size: s.size,
			storyPoints: s.storyPoints,
			draftingStage: s.draftingStage,
			assigneeId: s.assigneeId,
			taskCount: s.tasks?.length ?? 0,
			completedTaskCount:
				s.tasks?.filter((t) => t.isCompleted).length ?? 0,
			externalUrl: s.externalUrl,
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
		})),
		total,
		hasMore: offset + limit < total,
	});
}

async function handleGetFeature(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getStoryById, hasProjectAccess } = await import("@repo/database");

	const featureId = args.featureId as string;
	const projectId = args.projectId as string;
	if (!featureId) {
		return errorResult("featureId is required");
	}
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const story = await getStoryById(featureId, projectId);
	if (!story) {
		return errorResult("Feature not found");
	}

	// Find latest coding run with PR info
	const latestRun = story.tasks
		.flatMap((t) => t.codingRuns ?? [])
		.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() -
				new Date(a.createdAt).getTime(),
		)[0];

	return jsonResult({
		id: story.id,
		projectId: story.projectId,
		identifier: story.identifier,
		title: story.title,
		description: story.description,
		acceptanceCriteria: story.acceptanceCriteria,
		status: {
			id: story.status.id,
			name: story.status.name,
			color: story.status.color,
			isFinal: story.status.isFinal,
		},
		priority: story.priority,
		size: story.size,
		storyPoints: story.storyPoints,
		draftingStage: story.draftingStage,
		maturationStatus: story.maturationStatus,
		assigneeId: story.assigneeId,
		externalId: story.externalId,
		externalUrl: story.externalUrl,
		// Whether the linked PM-tool card still reflects this spec. Auto-sync is
		// off by default, so a card is a snapshot of the last manual push rather
		// than a live mirror — without this an agent reads the card as current.
		pmSync: {
			autoSyncEnabled: story.pmAutoSyncEnabled,
			lastSyncedStatusId: story.lastSyncedStatusId,
			statusDrifted:
				story.lastSyncedStatusId !== null &&
				story.lastSyncedStatusId !== story.statusId,
		},
		tasks: story.tasks.map((t) => ({
			id: t.id,
			identifier: t.identifier,
			title: t.title,
			description: t.description,
			isCompleted: t.isCompleted,
			estimatedHours: t.estimatedHours,
			assignedAgentId: t.assignedAgentId,
			repositoryUrl: t.repositoryUrl,
			repositoryOwner: t.repositoryOwner,
			repositoryName: t.repositoryName,
			targetBranch: t.targetBranch,
			subtasks: t.subtasks.map((st) => ({
				id: st.id,
				title: st.title,
				isCompleted: st.isCompleted,
			})),
		})),
		latestCodingRun: latestRun
			? {
					status: latestRun.status,
					pullRequestUrl: latestRun.pullRequestUrl,
					pullRequestNumber: latestRun.pullRequestNumber,
					provider: latestRun.provider,
					createdAt: latestRun.createdAt,
				}
			: null,
		createdAt: story.createdAt,
		updatedAt: story.updatedAt,
	});
}

/**
 * The Decision Log behind a feature. `listDecisionLogThreads` already drops
 * soft-deleted rows and threads roots with their replies, so this handler only
 * resolves the tenant filter, checks access and shapes the response.
 *
 * Superseded turns are excluded: this tool answers a model, and an amended
 * answer is retracted, so returning it alongside its replacement would present
 * two competing decisions for one question.
 */
async function handleGetFeatureDecisions(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getStoryById, hasProjectAccess, listDecisionLogThreads } =
		await import("@repo/database");

	const featureId = args.featureId as string;
	const projectId = args.projectId as string;
	if (!featureId) {
		return errorResult("featureId is required");
	}
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const story = await getStoryById(featureId, projectId);
	if (!story) {
		return errorResult("Feature not found");
	}

	const threads = await listDecisionLogThreads({
		tenantFilter: tenantFilter(session),
		userStoryId: featureId,
		excludeSuperseded: true,
	});

	const statusFilter = args.status as string | undefined;
	const selected = statusFilter
		? threads.filter((t) => t.root.status === statusFilter)
		: threads;

	return jsonResult({
		featureId,
		identifier: story.identifier,
		maturationStatus: story.maturationStatus,
		totalThreads: threads.length,
		openThreads: threads.filter((t) => t.root.status === "OPEN").length,
		// Surfaced as a count so a caller sees at a glance whether a person ever
		// weighed in — an all-AI_CONFIRMED log reads as "decided" but is not.
		humanAuthoredThreads: threads.filter((t) => t.root.source === "HUMAN")
			.length,
		threads: selected.map((thread) => ({
			id: thread.root.id,
			status: thread.root.status,
			topic: thread.root.topic,
			impactedSection: thread.root.impactedSection,
			summary: thread.root.summary,
			content: thread.root.content,
			authorType: thread.root.authorType,
			authorName: thread.root.authorName,
			source: thread.root.source,
			decidedBy: thread.root.decidedBy,
			sourceProvenance: thread.root.sourceProvenance,
			createdAt: thread.root.createdAt,
			replies: thread.replies.map((reply) => ({
				id: reply.id,
				content: reply.content,
				summary: reply.summary,
				authorType: reply.authorType,
				authorName: reply.authorName,
				source: reply.source,
				answerSource: reply.answerSource,
				decidedBy: reply.decidedBy,
				createdAt: reply.createdAt,
			})),
		})),
	});
}

/**
 * Revision history. Bodies are `@db.Text` and a mature spec runs to tens of KB,
 * so the list carries metadata only and a full revision is opt-in via `version`.
 */
async function handleGetFeatureVersions(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const {
		getFeatureVersion,
		getFeatureVersions,
		getStoryById,
		hasProjectAccess,
	} = await import("@repo/database");

	const featureId = args.featureId as string;
	const projectId = args.projectId as string;
	if (!featureId) {
		return errorResult("featureId is required");
	}
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const story = await getStoryById(featureId, projectId);
	if (!story) {
		return errorResult("Feature not found");
	}

	if (args.version !== undefined) {
		const requested = Number(args.version);
		const full = await getFeatureVersion(featureId, requested);
		if (!full) {
			return errorResult(
				`Version ${requested} not found for this feature`,
			);
		}
		return jsonResult({
			featureId,
			identifier: story.identifier,
			version: {
				version: full.version,
				createdAt: full.createdAt,
				draftingStage: full.draftingStage,
				changedBy: full.changedBy,
				changeDescription: full.changeDescription,
				changeSummary: full.changeSummary,
				description: full.description,
				acceptanceCriteria: full.acceptanceCriteria,
				summaryDigestSnapshot: full.summaryDigestSnapshot,
				workingNotesSnapshot: full.workingNotesSnapshot,
			},
		});
	}

	const { versions, total, hasMore } = await getFeatureVersions(
		featureId,
		Math.min((args.limit as number) ?? 20, 50),
		(args.offset as number) ?? 0,
	);

	return jsonResult({
		featureId,
		identifier: story.identifier,
		total,
		hasMore,
		versions: versions.map((version) => ({
			version: version.version,
			createdAt: version.createdAt,
			draftingStage: version.draftingStage,
			changedBy: version.changedBy,
			changeDescription: version.changeDescription,
			changeSummary: version.changeSummary,
		})),
	});
}

async function handleGetProjectStatuses(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listStoryStatuses, hasProjectAccess } = await import(
		"@repo/database"
	);

	const projectId = args.projectId as string;
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const statuses = await listStoryStatuses(projectId);
	return jsonResult({ statuses });
}

async function handleUpdateFeatureStatus(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { moveStory, hasProjectAccess, canEditProject } = await import(
		"@repo/database"
	);

	const featureId = args.featureId as string;
	const projectId = args.projectId as string;
	const statusId = args.statusId as string;
	if (!featureId) {
		return errorResult("featureId is required");
	}
	if (!projectId) {
		return errorResult("projectId is required");
	}
	if (!statusId) {
		return errorResult("statusId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const canEdit = await canEditProject(projectId, session.userId);
	if (!canEdit) {
		return errorResult("No edit permission for this project");
	}

	const updated = await moveStory(featureId, projectId, statusId, undefined, {
		lastEditedByName: session.userName,
		lastEditedSource: "MANUAL",
	});
	return jsonResult({
		success: true,
		featureId: updated.id,
		newStatus: { id: updated.status.id, name: updated.status.name },
	});
}

async function handleCompleteTask(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { updateTask, hasProjectAccess, db } = await import("@repo/database");

	const taskId = args.taskId as string;
	const projectId = args.projectId as string;
	const completed = (args.completed as boolean) ?? true;
	if (!taskId) {
		return errorResult("taskId is required");
	}
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	// Verify task belongs to a story in this project
	const task = await db.storyTask.findFirst({
		where: { id: taskId, story: { projectId } },
		select: { id: true, title: true, isCompleted: true },
	});
	if (!task) {
		return errorResult("Task not found in this project");
	}

	const updated = await updateTask(taskId, { isCompleted: completed });
	return jsonResult({
		success: true,
		taskId: updated.id,
		title: updated.title,
		isCompleted: updated.isCompleted,
	});
}

async function handleUpdateTask(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { updateTask, hasProjectAccess, db } = await import("@repo/database");

	const taskId = args.taskId as string;
	const projectId = args.projectId as string;
	if (!taskId) {
		return errorResult("taskId is required");
	}
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	// Verify task belongs to a story in this project
	const task = await db.storyTask.findFirst({
		where: { id: taskId, story: { projectId } },
		select: { id: true },
	});
	if (!task) {
		return errorResult("Task not found in this project");
	}

	const updated = await updateTask(taskId, {
		...(args.title !== undefined ? { title: args.title as string } : {}),
		...(args.description !== undefined
			? { description: args.description as string }
			: {}),
		...(args.isCompleted !== undefined
			? { isCompleted: args.isCompleted as boolean }
			: {}),
		...(args.repositoryUrl !== undefined
			? { repositoryUrl: args.repositoryUrl as string }
			: {}),
		...(args.targetBranch !== undefined
			? { targetBranch: args.targetBranch as string }
			: {}),
	});

	return jsonResult({
		success: true,
		taskId: updated.id,
		title: updated.title,
		isCompleted: updated.isCompleted,
		repositoryUrl: updated.repositoryUrl,
		targetBranch: updated.targetBranch,
	});
}

async function handleCreateFeatureTask(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createTask, hasProjectAccess, canEditProject, getStoryById } =
		await import("@repo/database");

	const featureId = args.featureId as string;
	const projectId = args.projectId as string;
	const title = args.title as string;
	if (!featureId) {
		return errorResult("featureId is required");
	}
	if (!projectId) {
		return errorResult("projectId is required");
	}
	if (!title) {
		return errorResult("title is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const canEdit = await canEditProject(projectId, session.userId);
	if (!canEdit) {
		return errorResult("No edit permission for this project");
	}

	// Verify the feature exists in this project
	const story = await getStoryById(featureId, projectId);
	if (!story) {
		return errorResult("Feature not found in this project");
	}

	const task = await createTask({
		storyId: featureId,
		title,
		description: args.description as string | undefined,
	});

	return jsonResult({
		success: true,
		taskId: task.id,
		identifier: task.identifier,
		title: task.title,
		featureId,
	});
}

/** Max stored length of a caller-supplied bug fingerprint. */
const BUG_FINGERPRINT_MAX_LENGTH = 200;

/**
 * Max title length. Matches the `z.string().min(1).max(500)` bound on the oRPC
 * `createStoryProcedure` input so the gateway cannot write a story the HTTP API
 * would have rejected.
 */
const STORY_TITLE_MAX_LENGTH = 500;

/**
 * Sanity bound on a work-item body written through the gateway. The oRPC
 * procedure sets no maximum — a human typing into the Add Feature dialog is
 * self-limiting — but a machine caller is not, and pasting a whole log file (or
 * a whole design doc) both blows up the drafting prompt and stores an
 * unreadable card. Generous enough for a full stack trace plus surrounding
 * context. Shared by every gateway create tool; the tools word the rejection
 * message for their own kind.
 */
const STORY_DESCRIPTION_MAX_LENGTH = 50_000;

const STORY_PRIORITIES = [
	"P0_CRITICAL",
	"P1_HIGH",
	"P2_MEDIUM",
	"P3_LOW",
] as const;
type StoryPriorityValue = (typeof STORY_PRIORITIES)[number];

const STORY_SIZES = ["XS", "S", "M", "L", "XL"] as const;
type StorySizeValue = (typeof STORY_SIZES)[number];

const STORY_KINDS = ["FEATURE", "BUG"] as const;
type StoryKindValue = (typeof STORY_KINDS)[number];

/**
 * Name of the partial unique index behind `UserStory.bugFingerprint`. Used to
 * tell a fingerprint collision apart from any other P2002 raised on the same
 * INSERT — see {@link isBugFingerprintConflict}.
 */
const BUG_FINGERPRINT_INDEX = "user_story_projectId_bugFingerprint_key";

/**
 * True only for a Prisma unique-constraint violation (P2002) whose target is
 * the bug-fingerprint index.
 *
 * Both halves matter. Duck-typing the error keeps this module's "no Prisma at
 * module scope" property — every DB import here is dynamic. Matching the target
 * keeps an UNRELATED unique violation on the same INSERT (the
 * `(projectId, identifier)` allocator backstop, say) from being reported to the
 * agent as "your bug already exists", which would silently swallow a real
 * allocator bug.
 *
 * The `meta.target` shape is driver-dependent — the index name, an array of
 * column names, or an underscore-joined column string — so all three are
 * accepted, mirroring the same discrimination in
 * `packages/api/modules/projects/procedures/stories/sync/import-from-pm.ts`.
 */
function isBugFingerprintConflict(error: unknown): boolean {
	if (
		typeof error !== "object" ||
		error === null ||
		(error as { code?: unknown }).code !== "P2002"
	) {
		return false;
	}
	const target = (error as { meta?: { target?: unknown } }).meta?.target;
	if (typeof target === "string") {
		return (
			target === BUG_FINGERPRINT_INDEX ||
			(target.includes("projectId") && target.includes("bugFingerprint"))
		);
	}
	if (Array.isArray(target)) {
		return (
			target.includes("projectId") && target.includes("bugFingerprint")
		);
	}
	return false;
}

/** Either the refusal to hand straight back, or the authorized project. */
type ProjectWriteResolution =
	| { ok: false; error: ToolCallResult }
	| { ok: true; project: { id: string; organizationId: string | null } };

/**
 * Shared authorization preamble for every gateway tool that writes a work item
 * into a project. Membership → tenant XOR → STORY_CREATE, in that order.
 *
 * TENANT SCOPING — why the middle step exists at all: `hasProjectAccess` proves
 * MEMBERSHIP but not context. It ignores its `organizationId` argument entirely
 * (`packages/database/prisma/queries/projects/projects.ts:918`), so a caller
 * whose gateway session is active in org A can name an org-B project (or a
 * personal one) and pass. Every write path therefore also compares the
 * project's own owner org against the session's and refuses a mismatch —
 * otherwise the item would be drafted with one tenant's context and written
 * into another's project. Both sides are normalised to `null` so personal
 * (`null`) and org contexts compare exactly, never loosely.
 *
 * The ordering is load-bearing: a non-member must not learn which tenant owns a
 * project id they guessed, and the permission check runs last so a refusal
 * costs one query rather than three.
 *
 * The STORY_CREATE check is `canCreateProjectStory`, not `canEditProject` —
 * `hasProjectAccess` alone also admits Viewers/Commenters. Mirrors the
 * in-platform `fabric_create_story` tool and the `createStoryProcedure` gate.
 */
async function resolveProjectForStoryWrite(
	projectId: string,
	session: GatewaySession,
): Promise<ProjectWriteResolution> {
	const { db, hasProjectAccess, canCreateProjectStory } = await import(
		"@repo/database"
	);

	// Membership. Necessary but NOT sufficient — see the tenant-scoping note
	// above.
	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return {
			ok: false,
			error: errorResult("Project not found or access denied"),
		};
	}

	// Tenant XOR: the project's owning tenant must be the session's active one.
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true, organizationId: true },
	});
	if (!project) {
		return {
			ok: false,
			error: errorResult("Project not found or access denied"),
		};
	}
	const projectOrganizationId = project.organizationId ?? null;
	const sessionOrganizationId = session.organizationId ?? null;
	if (projectOrganizationId !== sessionOrganizationId) {
		return {
			ok: false,
			error: errorResult(
				projectOrganizationId
					? `This project belongs to a different organization than your active session context. Call fabric_switch_organization with organizationId="${projectOrganizationId}" first, then retry.`
					: "This is a personal project and your session is scoped to an organization. Call fabric_switch_organization with organizationId=null first, then retry.",
			),
		};
	}

	const canCreate = await canCreateProjectStory(projectId, session.userId);
	if (!canCreate) {
		return {
			ok: false,
			error: errorResult(
				"No permission to create work items in this project",
			),
		};
	}

	return { ok: true, project };
}

/**
 * Is a row the `BacklogDedupGuard` matched still a LIVE duplicate?
 *
 * Everything the guard reports is a snapshot taken when the guard was built,
 * and every caller reaches this question after at least one more round-trip, so
 * the row may have been closed or deleted in between. A terminal row is a
 * resolved record, not a duplicate — reporting one as the dedup hit would tell
 * the agent its report is already covered by a ticket nobody is working on.
 */
async function isBacklogCollisionStillLive(storyId: string): Promise<boolean> {
	const { db, TERMINAL_DRAFTING_STAGES } = await import("@repo/database");
	const matched = await db.userStory.findUnique({
		where: { id: storyId },
		select: { id: true, draftingStage: true },
	});
	return (
		!!matched && !TERMINAL_DRAFTING_STAGES.includes(matched.draftingStage)
	);
}

/**
 * Announce a genuinely new work item. Both writes are fire-and-forget and
 * neither may fail the create — the row is already persisted by the time this
 * runs.
 *
 * Without the lifecycle event, project automations that trigger on story
 * creation fire for the Add Feature dialog and for the in-platform
 * `fabric_create_story` tool but silently skip anything an external agent
 * files, which is the one source most likely to want an automation.
 *
 * Call ONLY on an actual create — never on a dedup hit or a back-fill, where no
 * row came into existence.
 *
 * `via` names the gateway tool that filed the row, and `metadataExtras` carries
 * whatever else is diagnostic for that tool (the bug tool records whether the
 * caller supplied a fingerprint); both land on the audit row's metadata.
 */
function announceStoryCreated(params: {
	session: GatewaySession;
	projectId: string;
	story: { id: string; title: string; statusId: string; kind: string };
	aiDrafted: boolean;
	via: string;
	metadataExtras?: Record<string, unknown>;
}): void {
	const { session, projectId, story, aiDrafted, via, metadataExtras } =
		params;

	import("@repo/temporal")
		.then(({ dispatchLifecycleEvent }) =>
			dispatchLifecycleEvent({
				resource: "story",
				event: "created",
				projectId,
				entityId: story.id,
				userId: session.userId,
				organizationId: session.organizationId ?? null,
				data: {
					storyId: story.id,
					title: story.title,
					statusId: story.statusId,
					aiDrafted,
				},
			}),
		)
		.catch((error) => {
			console.warn(
				"[MCP Gateway] story.created lifecycle dispatch failed:",
				error,
			);
		});

	// Audit row, mirroring createStoryProcedure. `recordAuditFromRequest`
	// is documented as callable from any shape-compatible context and
	// swallows its own failures, so a synthetic context is safe here. There
	// is no HTTP request in scope at this layer, so ip / user-agent /
	// request-id resolve to null rather than being invented.
	import("@repo/api/lib/audit")
		.then(({ recordAuditFromRequest }) => {
			recordAuditFromRequest(
				{
					user: {
						id: session.userId,
						email: session.email,
						name: session.userName,
					},
					// The MCP gateway session id, not a Better Auth session
					// id — it is the correlation handle that actually exists
					// on this path.
					session: {
						id: session.sessionId,
						activeOrganizationId: session.organizationId,
					},
				},
				{
					action: "story.created",
					category: "story",
					organizationId: session.organizationId,
					projectId,
					resource: {
						type: "story",
						id: story.id,
						name: story.title ?? null,
					},
					metadata: {
						kind: story.kind,
						statusId: story.statusId,
						aiDrafted,
						via,
						// This helper runs ONLY for an actual insert, so a
						// row it describes is by construction not a dedup
						// hit.
						deduplicated: false,
						...metadataExtras,
					},
				},
			);
		})
		.catch((error) => {
			console.warn("[MCP Gateway] story.created audit failed:", error);
		});
}

/**
 * `fabric_create_bug` — file a BUG work item, deduped twice.
 *
 * The caller is expected to be an autonomous monitor that re-reports the same
 * failure on every sighting, so "already filed" must be an ordinary success:
 * both dedup layers return `created: false` with the existing row's id and
 * identifier, never an error the agent would retry around.
 *
 *  1. Fingerprint (hard). An exact, title-independent key. The read below is
 *     scoped to the SAME predicate as the partial unique index — non-terminal
 *     rows only — so a closed/declined bug never blocks re-filing a regression,
 *     and the index is the backstop for the check-then-create race (P2002 →
 *     re-read the winner).
 *  2. Title, via `BacklogDedupGuard` with family BUG. Same semantics as the
 *     in-platform `fabric_create_story` tool: per-project, per-family,
 *     normalized-title, non-terminal rows only. This layer is BEST-EFFORT and
 *     known to be leaky: the bug-drafting prompt may rewrite a title after
 *     creation, at which point the stored title no longer matches what the
 *     agent will send next time. That is why a title hit back-fills the
 *     caller's fingerprint onto the matched row (see below) — one title match
 *     is enough to convert a fragile match into a durable one.
 *
 * Creation goes through `createStoryFromProposal` (the shared path used by the
 * manual Add Feature procedure, proposal approval, and `fabric_create_story`)
 * so the bug gets atomic identifier allocation, default-status placement, and
 * the project's bug-drafting prompt. `skipClassifier` is set because the tool
 * name is the caller's declaration of kind — letting the classifier flip this
 * row to FEATURE would put it in the wrong dedup family on the next sighting.
 * An actual create also emits the `story.created` lifecycle event and an audit
 * row, so a machine-filed bug is indistinguishable downstream from one filed
 * through the UI — see {@link announceStoryCreated}.
 *
 * Membership, tenant XOR and STORY_CREATE are all handled by
 * {@link resolveProjectForStoryWrite}, which carries the reasoning for why a
 * membership check alone is not enough to prove tenant context.
 */
async function handleCreateBug(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { db, buildBacklogDedupGuard, TERMINAL_DRAFTING_STAGES } =
		await import("@repo/database");

	if (typeof args.projectId !== "string" || !args.projectId.trim()) {
		return errorResult(
			"projectId is required and must be a non-empty string — get one from fabric_list_projects",
		);
	}
	const projectId = args.projectId.trim();
	if (typeof args.title !== "string" || !args.title.trim()) {
		return errorResult("title is required");
	}
	const title = args.title.trim();
	if (title.length > STORY_TITLE_MAX_LENGTH) {
		return errorResult(
			`title must be ${STORY_TITLE_MAX_LENGTH} characters or fewer (received ${title.length}) — keep it to a one-line symptom and move the detail into 'description'`,
		);
	}

	if (
		args.description !== undefined &&
		typeof args.description !== "string"
	) {
		return errorResult("description must be a string when provided");
	}
	const trimmedDescription =
		typeof args.description === "string" ? args.description.trim() : "";
	if (trimmedDescription.length > STORY_DESCRIPTION_MAX_LENGTH) {
		return errorResult(
			`description must be ${STORY_DESCRIPTION_MAX_LENGTH} characters or fewer (received ${trimmedDescription.length}) — send the relevant stack frames and error text, not a whole log file`,
		);
	}
	const description = trimmedDescription || undefined;

	if (
		args.fingerprint !== undefined &&
		typeof args.fingerprint !== "string"
	) {
		return errorResult("fingerprint must be a string when provided");
	}
	const fingerprint =
		typeof args.fingerprint === "string" && args.fingerprint.trim()
			? args.fingerprint.trim()
			: undefined;
	if (fingerprint && fingerprint.length > BUG_FINGERPRINT_MAX_LENGTH) {
		return errorResult(
			`fingerprint must be ${BUG_FINGERPRINT_MAX_LENGTH} characters or fewer (received ${fingerprint.length}) — hash the error signature instead of sending it verbatim`,
		);
	}

	// Reject an unrecognised priority rather than coercing it: the gateway
	// routes hand `arguments` straight through with no schema validation, so
	// silently downgrading "P1" or "critical" to P2_MEDIUM would file a P0
	// outage at medium severity and tell the agent it succeeded.
	if (
		args.priority !== undefined &&
		!STORY_PRIORITIES.includes(args.priority as StoryPriorityValue)
	) {
		return errorResult(
			`priority must be one of ${STORY_PRIORITIES.join(", ")} (received ${JSON.stringify(args.priority)})`,
		);
	}
	const priority = (args.priority as StoryPriorityValue) ?? "P2_MEDIUM";

	// Membership → tenant XOR → STORY_CREATE.
	const resolved = await resolveProjectForStoryWrite(projectId, session);
	if (!resolved.ok) {
		return resolved.error;
	}

	// ── Layer 1: fingerprint dedup (exact, title-independent) ──
	const findByFingerprint = async (key: string) =>
		db.userStory.findFirst({
			where: {
				projectId,
				bugFingerprint: key,
				draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
			},
			select: { id: true, identifier: true, title: true },
			orderBy: { createdAt: "asc" },
		});

	const fingerprintHitResult = (existing: {
		id: string;
		identifier: string;
		title: string;
	}) =>
		jsonResult({
			success: true,
			created: false,
			dedupedBy: "fingerprint",
			id: existing.id,
			identifier: existing.identifier,
			title: existing.title,
			message: `An open bug with this fingerprint already exists in this project as ${existing.identifier}. Returned it instead of filing a duplicate — add new evidence to that item rather than re-reporting.`,
		});

	if (fingerprint) {
		const existing = await findByFingerprint(fingerprint);
		if (existing) {
			return fingerprintHitResult(existing);
		}
	}

	// ── Layer 2: normalized-title dedup, BUG family only ──
	const dedupGuard = await buildBacklogDedupGuard(projectId);
	const collision = dedupGuard.findCollision("BUG", title);

	const titleHitResult = (
		matched: { existingId: string; existingIdentifier: string },
		fingerprintAttached: boolean,
	) =>
		jsonResult({
			success: true,
			created: false,
			dedupedBy: "title",
			id: matched.existingId,
			identifier: matched.existingIdentifier,
			title,
			fingerprintAttached,
			message: `A bug titled "${title}" already exists in this project as ${matched.existingIdentifier}. Returned it instead of filing a duplicate; update that item if you have new information.${
				fingerprintAttached
					? " Your fingerprint has been attached to that bug, so future reports of this error will match it exactly."
					: ""
			}`,
		});

	if (collision) {
		// Back-fill the fingerprint onto the matched row. Title matching is
		// fragile — the drafting prompt rewrites titles — so converting this
		// one lucky match into a fingerprint means the NEXT sighting hits
		// layer 1 and no longer depends on the title surviving unchanged.
		//
		// The `where` is a compare-and-set needing no transaction, and it
		// carries the NON-TERMINAL predicate as well as `bugFingerprint: null`.
		// The guard's index is a snapshot: the row it matched can be closed
		// between `buildBacklogDedupGuard` and this write, and stamping a
		// fingerprint onto a closed bug would both violate terminal-item
		// immutability and park the fingerprint outside the partial index,
		// wrongly reporting a resolved ticket as the live duplicate.
		if (!fingerprint) {
			// No fingerprint to back-fill, so no fresh read is taken and the
			// guard's snapshot is all we know. Same staleness every other
			// BacklogDedupGuard caller lives with.
			return titleHitResult(collision, false);
		}

		/** Is the title-matched row still a LIVE duplicate? */
		const collisionStillLive = () =>
			isBacklogCollisionStillLive(collision.existingId);

		/**
		 * Attempt the back-fill and decide what the caller should be told.
		 * Returns `null` to mean "nothing here covers this report" — fall
		 * through and file a new bug.
		 */
		const resolveTitleHit = async (): Promise<ToolCallResult | null> => {
			let attachedCount: number;
			try {
				const { count } = await db.userStory.updateMany({
					where: {
						id: collision.existingId,
						bugFingerprint: null,
						draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
					},
					data: { bugFingerprint: fingerprint },
				});
				attachedCount = count;
			} catch (error) {
				if (!isBugFingerprintConflict(error)) {
					throw error;
				}
				// Another row in this project already holds the fingerprint, so
				// the partial unique index refused the back-fill.
				const winner = await findByFingerprint(fingerprint);
				if (winner) {
					// That row — not this title match — is the answer.
					return fingerprintHitResult(winner);
				}
				// The holder went terminal in the window, so it is no longer a
				// live duplicate and the index no longer covers it. Fall back
				// to the title match — but only if THAT is still open too. The
				// failed update proves nothing about its current state: the
				// conflict comes from the index, so the row satisfied the
				// non-terminal predicate at write time and can have been closed
				// since. When both candidates are resolved, nothing covers this
				// report and a now-meaningless P2002 must not surface.
				return (await collisionStillLive())
					? titleHitResult(collision, false)
					: null;
			}

			if (attachedCount > 0) {
				return titleHitResult(collision, true);
			}

			// Nothing matched. Two very different reasons, so read the row to
			// find out which: it already carried a fingerprint (fine — still a
			// live duplicate), or it went terminal / was deleted underneath us
			// (in which case it is NOT a duplicate).
			return (await collisionStillLive())
				? titleHitResult(collision, false)
				: null;
		};

		const titleOutcome = await resolveTitleHit();
		if (titleOutcome) {
			return titleOutcome;
		}
		// Fall through to creation.
	}

	const { createStoryFromProposal } = await import("@repo/temporal");

	const create = async () =>
		createStoryFromProposal({
			projectId,
			organizationId: session.organizationId,
			createdById: session.userId,
			title,
			description,
			kind: "BUG",
			// The tool contract IS the kind declaration — see the doc comment.
			skipClassifier: true,
			priority,
			draftingStage: "PLACEHOLDER",
			source: "CUSTOM_AGENT",
			bugFingerprint: fingerprint ?? null,
		});

	/**
	 * Announce a genuinely new row — see {@link announceStoryCreated}. Called
	 * ONLY on an actual create, never on a dedup hit or a back-fill.
	 */
	const announceCreated = (
		story: { id: string; title: string; statusId: string; kind: string },
		aiDrafted: boolean,
	) =>
		announceStoryCreated({
			session,
			projectId,
			story,
			aiDrafted,
			via: "mcp-gateway:fabric_create_bug",
			metadataExtras: {
				// Whether the caller supplied a fingerprint is the genuinely
				// useful signal — it separates a monitor that can be deduped
				// from one that cannot.
				fingerprintProvided: Boolean(fingerprint),
			},
		});

	const createdResult = (story: {
		id: string;
		identifier: string;
		title: string;
		kind: string;
		priority: string;
		draftingStage: string;
	}) =>
		jsonResult({
			success: true,
			created: true,
			dedupedBy: null,
			id: story.id,
			identifier: story.identifier,
			title: story.title,
			kind: story.kind,
			priority: story.priority,
			draftingStage: story.draftingStage,
			fingerprint: fingerprint ?? null,
			message: `Filed bug ${story.identifier}.`,
		});

	try {
		const { story, aiDrafted } = await create();
		announceCreated(story, aiDrafted);
		return createdResult(story);
	} catch (error) {
		// Only a fingerprint-index conflict is a dedup outcome. Any other P2002
		// (the (projectId, identifier) allocator backstop, say) is a real fault
		// and must not be dressed up as "already filed".
		if (!fingerprint || !isBugFingerprintConflict(error)) {
			throw error;
		}
		const winner = await findByFingerprint(fingerprint);
		if (winner) {
			return fingerprintHitResult(winner);
		}
		// The row that won the race went terminal inside the window, so it no
		// longer holds the fingerprint in the index and no longer answers the
		// caller's report. Re-file EXACTLY ONCE.
		try {
			const { story, aiDrafted } = await create();
			announceCreated(story, aiDrafted);
			return createdResult(story);
		} catch (retryError) {
			// A third racer beat the retry. There is no second retry: resolve
			// to whoever now holds the fingerprint and report it as the dedup
			// hit it is. Only a conflict with nothing behind it is a real fault.
			if (isBugFingerprintConflict(retryError)) {
				const retryWinner = await findByFingerprint(fingerprint);
				if (retryWinner) {
					return fingerprintHitResult(retryWinner);
				}
			}
			throw retryError;
		}
	}
}

/**
 * `fabric_create_feature` — file a FEATURE work item, deduped by title.
 *
 * Deliberately much thinner than {@link handleCreateBug}. A bug report carries
 * an error signature, so the bug tool can dedupe on a caller-supplied
 * fingerprint and treat re-reporting as routine. A feature request has no such
 * machine key — a "fingerprint" of a capability request is just its title — so
 * this tool has exactly ONE dedup layer: the normalized title, via
 * `BacklogDedupGuard` with family FEATURE (per-project, per-family,
 * non-terminal rows only). Feature titles are never matched against bugs, and a
 * closed or declined item never blocks a new filing.
 *
 * A hit is still success-shaped (`created: false`, `dedupedBy: "title"`) rather
 * than an error, so an agent that files the same request twice is told what
 * already covers it instead of being nudged into rewording the title until it
 * gets a second row. With no fingerprint there is nothing to back-fill and no
 * partial unique index to race against, so none of the bug tool's P2002
 * machinery applies here.
 *
 * Creation goes through `createStoryFromProposal` — the shared path used by the
 * manual Add Feature procedure, proposal approval, and `fabric_create_story` —
 * so the feature gets atomic identifier allocation, default-status placement,
 * and the project's feature-drafting prompt. `skipClassifier` is set because
 * the tool name is the caller's declaration of kind: letting the classifier
 * flip this row to BUG would put it in the wrong dedup family on the next
 * request, and would draft it through the wrong prompt.
 *
 * Membership, tenant XOR and STORY_CREATE are all handled by
 * {@link resolveProjectForStoryWrite}.
 */
async function handleCreateFeature(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { buildBacklogDedupGuard } = await import("@repo/database");

	if (typeof args.projectId !== "string" || !args.projectId.trim()) {
		return errorResult(
			"projectId is required and must be a non-empty string — get one from fabric_list_projects",
		);
	}
	const projectId = args.projectId.trim();
	if (typeof args.title !== "string" || !args.title.trim()) {
		return errorResult("title is required");
	}
	const title = args.title.trim();
	if (title.length > STORY_TITLE_MAX_LENGTH) {
		return errorResult(
			`title must be ${STORY_TITLE_MAX_LENGTH} characters or fewer (received ${title.length}) — keep it to a one-line capability statement and move the detail into 'description'`,
		);
	}

	if (
		args.description !== undefined &&
		typeof args.description !== "string"
	) {
		return errorResult("description must be a string when provided");
	}
	const trimmedDescription =
		typeof args.description === "string" ? args.description.trim() : "";
	if (trimmedDescription.length > STORY_DESCRIPTION_MAX_LENGTH) {
		return errorResult(
			`description must be ${STORY_DESCRIPTION_MAX_LENGTH} characters or fewer (received ${trimmedDescription.length}) — send the request and the context around it, not a pasted design document`,
		);
	}
	const description = trimmedDescription || undefined;

	// Reject an unrecognised priority or size rather than coercing it: the
	// gateway routes hand `arguments` straight through with no schema
	// validation, so silently defaulting "P1" or "medium" to P2_MEDIUM would
	// file an urgent request at the wrong band and report success.
	if (
		args.priority !== undefined &&
		!STORY_PRIORITIES.includes(args.priority as StoryPriorityValue)
	) {
		return errorResult(
			`priority must be one of ${STORY_PRIORITIES.join(", ")} (received ${JSON.stringify(args.priority)})`,
		);
	}
	const priority = (args.priority as StoryPriorityValue) ?? "P2_MEDIUM";

	if (
		args.size !== undefined &&
		!STORY_SIZES.includes(args.size as StorySizeValue)
	) {
		return errorResult(
			`size must be one of ${STORY_SIZES.join(", ")} (received ${JSON.stringify(args.size)}) — omit it if you do not have a basis for the estimate`,
		);
	}
	const size = args.size as StorySizeValue | undefined;

	// Membership → tenant XOR → STORY_CREATE.
	const resolved = await resolveProjectForStoryWrite(projectId, session);
	if (!resolved.ok) {
		return resolved.error;
	}

	// ── Normalized-title dedup, FEATURE family only ──
	const dedupGuard = await buildBacklogDedupGuard(projectId);
	const collision = dedupGuard.findCollision("FEATURE", title);
	if (
		collision &&
		(await isBacklogCollisionStillLive(collision.existingId))
	) {
		return jsonResult({
			success: true,
			created: false,
			dedupedBy: "title",
			id: collision.existingId,
			identifier: collision.existingIdentifier,
			title,
			message: `A feature titled "${title}" already exists in this project as ${collision.existingIdentifier}. Returned it instead of filing a duplicate. If you have details it does not cover, attach them with fabric_create_feature_task rather than resending with a reworded title.`,
		});
	}
	// A matched row that went terminal or vanished since the guard was built is
	// not a live duplicate, so fall through and create.

	const { createStoryFromProposal } = await import("@repo/temporal");

	const { story, aiDrafted } = await createStoryFromProposal({
		projectId,
		organizationId: session.organizationId,
		createdById: session.userId,
		title,
		description,
		kind: "FEATURE",
		// The tool contract IS the kind declaration — see the doc comment.
		skipClassifier: true,
		priority,
		size,
		draftingStage: "PLACEHOLDER",
		source: "CUSTOM_AGENT",
	});

	announceStoryCreated({
		session,
		projectId,
		story,
		aiDrafted,
		via: "mcp-gateway:fabric_create_feature",
	});

	return jsonResult({
		success: true,
		created: true,
		dedupedBy: null,
		id: story.id,
		identifier: story.identifier,
		title: story.title,
		kind: story.kind,
		priority: story.priority,
		size: story.size ?? null,
		draftingStage: story.draftingStage,
		message: `Filed feature ${story.identifier}.`,
	});
}

// ─── Document Handlers ──────────────────────────────────────────────────────

async function handleListDocuments(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listDocuments, hasProjectAccess } = await import("@repo/database");

	const projectId = args.projectId as string;
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const result = await listDocuments({
		projectId,
		type: args.type as
			| "GENERAL"
			| "PRD"
			| "PROPOSAL"
			| "ARCHITECTURE"
			| "TECHNICAL_SPEC"
			| "USER_STORY"
			| "API_SPEC"
			| undefined,
		limit: Math.min((args.limit as number) ?? 20, 50),
		offset: (args.offset as number) ?? 0,
	});

	return jsonResult({
		documents: result.documents.map((d) => ({
			id: d.id,
			projectId: d.projectId,
			type: d.type,
			title: d.title,
			status: d.status,
			createdAt: d.createdAt,
			updatedAt: d.updatedAt,
		})),
		total: result.total,
		hasMore: result.hasMore,
	});
}

async function handleGetDocument(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getDocumentById, hasProjectAccess } = await import(
		"@repo/database"
	);

	const documentId = args.documentId as string;
	if (!documentId) {
		return errorResult("documentId is required");
	}

	const doc = await getDocumentById(documentId);
	if (!doc) {
		return errorResult("Document not found");
	}

	// Verify access to the parent project
	const hasAccess = await hasProjectAccess(
		doc.projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Document not found or access denied");
	}

	return jsonResult({
		id: doc.id,
		projectId: doc.projectId,
		type: doc.type,
		title: doc.title,
		content: doc.content,
		status: doc.status,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
	});
}

async function handleCreateDocument(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createDocument, canEditProject, hasProjectAccess } = await import(
		"@repo/database"
	);

	const projectId = args.projectId as string;
	const type = args.type as string;
	const title = args.title as string;
	const content = args.content as string;
	if (!projectId) {
		return errorResult("projectId is required");
	}
	if (!type) {
		return errorResult("type is required");
	}
	if (!title) {
		return errorResult("title is required");
	}
	if (!content && content !== "") {
		return errorResult("content is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const canEdit = await canEditProject(projectId, session.userId);
	if (!canEdit) {
		return errorResult("No edit permission for this project");
	}

	const doc = await createDocument({
		projectId,
		type: type as
			| "GENERAL"
			| "PRD"
			| "PROPOSAL"
			| "ARCHITECTURE"
			| "TECHNICAL_SPEC"
			| "USER_STORY"
			| "API_SPEC",
		title,
		content,
		status:
			(args.status as
				| "DRAFT"
				| "GENERATING"
				| "IN_PROGRESS"
				| "REVIEW"
				| "COMPLETE"
				| "FAILED"
				| undefined) ?? "DRAFT",
		lastEditedBy: session.userId,
		userId: session.userId,
		organizationId: session.organizationId ?? undefined,
	});

	return jsonResult({
		success: true,
		documentId: doc.id,
		projectId: doc.projectId,
		type: doc.type,
		title: doc.title,
		status: doc.status,
		version: doc.version,
	});
}

async function handleUpdateDocument(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const {
		updateDocument,
		getDocumentById,
		canEditProject,
		hasProjectAccess,
	} = await import("@repo/database");

	const documentId = args.documentId as string;
	if (!documentId) {
		return errorResult("documentId is required");
	}

	const doc = await getDocumentById(documentId);
	if (!doc) {
		return errorResult("Document not found");
	}

	const hasAccess = await hasProjectAccess(
		doc.projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Document not found or access denied");
	}

	const canEdit = await canEditProject(doc.projectId, session.userId);
	if (!canEdit) {
		return errorResult("No edit permission for this project");
	}

	const updated = await updateDocument(documentId, {
		...(args.title !== undefined ? { title: args.title as string } : {}),
		...(args.content !== undefined
			? { content: args.content as string }
			: {}),
		...(args.status !== undefined
			? {
					status: args.status as
						| "DRAFT"
						| "GENERATING"
						| "IN_PROGRESS"
						| "REVIEW"
						| "COMPLETE"
						| "FAILED",
				}
			: {}),
		...(args.changeDescription !== undefined
			? { changeDescription: args.changeDescription as string }
			: {}),
		lastEditedBy: session.userId,
		userId: session.userId,
		organizationId: session.organizationId ?? undefined,
	});

	return jsonResult({
		success: true,
		documentId: updated.id,
		title: updated.title,
		status: updated.status,
		version: updated.version,
	});
}

// ─── Workspace Handlers ─────────────────────────────────────────────────────

// ─── Project Context Handlers ───────────────────────────────────────────────

/** Default / ceiling for one page of context body text, in characters. */
const CONTEXT_BODY_DEFAULT_MAX_LENGTH = 50_000;
const CONTEXT_BODY_MAX_LENGTH = 200_000;

/** How long the presigned link to a stored file stays valid. */
const CONTEXT_FILE_URL_EXPIRY_SECONDS = 300;

/** Context types whose bytes are the point — the extracted text is secondary. */
const BINARY_CONTEXT_TYPES = new Set([
	"FILE",
	"IMAGE",
	"DOCUMENT",
	"SPREADSHEET",
]);

interface ContextRowLike {
	type: string;
	sourceTitle?: string | null;
	originalFilename?: string | null;
	extractionStatus?: string | null;
	extractionError?: string | null;
	metadata?: unknown;
}

/** Narrow a context row's loose `metadata` JSON to a plain record. */
function contextMetadata(metadata: unknown): Record<string, unknown> {
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: {};
}

/** Resolve a display title from the columns, then the metadata fallbacks. */
function resolveContextTitle(ctx: ContextRowLike): string {
	if (ctx.sourceTitle) {
		return ctx.sourceTitle;
	}
	const meta = contextMetadata(ctx.metadata);
	for (const key of ["title", "documentTitle", "sourceTitle", "filename"]) {
		const value = meta[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return ctx.originalFilename || "Untitled context";
}

/** Resolve the integration provider slug, if this context came from one. */
function resolveContextProvider(ctx: ContextRowLike): string | null {
	const meta = contextMetadata(ctx.metadata);
	const provider = meta.provider ?? meta.integrationProvider;
	return typeof provider === "string" && provider.length > 0
		? provider
		: null;
}

/**
 * Explain why a context has no readable body, in terms the caller can act
 * on. The INTEGRATION branch is the one that matters most: a linked Teams or
 * Slack conversation is a monitor pointer, so it is marked COMPLETED with an
 * empty `content` forever — its messages are analysed into backlog proposals
 * and never stored on the context. Returning a bare empty string there would
 * read as "the conversation was empty".
 *
 * A one-to-one or group chat gets its own sentence ahead of that one, because
 * the generic wording is false for it: it says the messages *are* captured
 * elsewhere, and for a private chat nothing is captured anywhere. An agent
 * told to look in "separate conversation records" would search for something
 * that does not exist. This matches `PRIVATE_CONVERSATION_EXCLUDED` in the
 * export's taxonomy — one fact, told the same way on both surfaces.
 */
function resolveContextUnavailableReason(ctx: ContextRowLike): string {
	const status = ctx.extractionStatus ?? "";

	if (status === "PENDING" || status === "EXTRACTING") {
		return "Extraction is still in progress — retry shortly.";
	}
	if (status === "FAILED") {
		return ctx.extractionError
			? `Extraction failed: ${ctx.extractionError}`
			: "Extraction failed for this source.";
	}
	if (ctx.type === "INTEGRATION") {
		const pointer = classifyConversationPointer({
			type: ctx.type,
			metadata: ctx.metadata ?? null,
		});
		if (pointer?.kind === "PRIVATE_CHAT") {
			return (
				`This source pins a linked ${pointer.sourceSystem} chat. One-to-one and group chats are ` +
				`not captured by design, so no messages are stored for it here — read them in ${pointer.sourceSystem}.`
			);
		}
		return (
			"This source pins a monitored external conversation. Its messages are captured into " +
			"separate conversation records rather than onto the context row, so an empty body " +
			"does not mean an empty conversation."
		);
	}
	if (BINARY_CONTEXT_TYPES.has(ctx.type)) {
		return "No text was extracted from this file — read the original via 'originalFile.url'.";
	}
	return "No content is stored for this context.";
}

async function handleListProjectContexts(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { hasProjectAccess, listProjectContextSummaries } = await import(
		"@repo/database"
	);

	const projectId = args.projectId as string;
	if (!projectId) {
		return errorResult("projectId is required");
	}

	const hasAccess = await hasProjectAccess(
		projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Project not found or access denied");
	}

	const result = await listProjectContextSummaries({
		projectId,
		type: args.type as Parameters<
			typeof listProjectContextSummaries
		>[0]["type"],
		includeCodeContexts: args.includeCodeContexts === true,
		limit: Math.min((args.limit as number) ?? 50, 200),
		offset: (args.offset as number) ?? 0,
	});

	return jsonResult({
		projectId,
		contexts: result.contexts.map((ctx) => ({
			id: ctx.id,
			type: ctx.type,
			title: resolveContextTitle(ctx),
			source: resolveContextProvider(ctx),
			filename: ctx.originalFilename,
			mimeType: ctx.mimeType,
			fileSizeBytes: ctx.fileSize,
			sourceUrl: ctx.sourceUrl,
			extractionStatus: ctx.extractionStatus,
			contentAvailable: ctx.hasContent,
			...(ctx.hasContent
				? {}
				: {
						unavailableReason: resolveContextUnavailableReason(ctx),
					}),
			hasOriginalFile: ctx.hasStoredFile,
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		})),
		total: result.total,
		hasMore: result.hasMore,
		excludedCodeContexts: result.excludedCodeContexts,
	});
}

async function handleGetProjectContext(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const {
		getCapturedConversationMarkdown,
		getContextById,
		getCrawledUrlSourceMarkdown,
		hasProjectAccess,
	} = await import("@repo/database");

	const contextId = args.contextId as string;
	if (!contextId) {
		return errorResult("contextId is required");
	}

	const ctx = await getContextById(contextId);
	if (!ctx) {
		return errorResult("Context not found");
	}

	// Tenant isolation: the unscoped lookup above resolves any row, so access
	// is decided here, on the parent project — the same gate every other
	// gateway handler applies.
	const hasAccess = await hasProjectAccess(
		ctx.projectId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Context not found or access denied");
	}

	// Two kinds of row keep their text somewhere other than `content`, and both
	// have to be reassembled before reading.
	//
	// A PATH_PREFIX URL source scatters its markdown across child page rows. A
	// monitored Teams or Slack channel is a pointer whose captured conversation
	// lives in `ProjectContextConversationBundle` (Fizzy #2228) — this read is a
	// path no retrieval-time guard covers, so it is exactly where an empty body
	// used to be indistinguishable from an empty conversation.
	//
	// The bundle text arrives already neutralized against prompt injection: the
	// capture path applies the guard before the row write so every derived copy
	// inherits it. Nothing is re-applied here.
	let body: string;
	if (ctx.type === "LINK" && ctx.urlScope === "PATH_PREFIX") {
		body = await getCrawledUrlSourceMarkdown(ctx.id, {
			userId: session.userId,
			organizationId: session.organizationId,
		});
	} else if (ctx.type === "INTEGRATION") {
		const captured = await getCapturedConversationMarkdown(ctx.id, {
			userId: session.userId,
			organizationId: session.organizationId,
		});
		// An integration with nothing captured falls back to whatever the row
		// itself holds — which for a monitored channel is "", and then
		// `resolveContextUnavailableReason` explains why rather than implying
		// the conversation was empty.
		body = captured.length > 0 ? captured : (ctx.content ?? "");
	} else {
		body = ctx.content ?? "";
	}

	const offset = Math.max((args.offset as number) ?? 0, 0);
	const maxLength = Math.min(
		Math.max(
			(args.maxLength as number) ?? CONTEXT_BODY_DEFAULT_MAX_LENGTH,
			1,
		),
		CONTEXT_BODY_MAX_LENGTH,
	);
	const page = body.slice(offset, offset + maxLength);
	const truncated = offset + page.length < body.length;

	// Blank is not the same as non-empty. A scanned or photo-only PDF extracts
	// to whitespace — COMPLETED status, `"\n\n"` for content — and reporting
	// that as readable hands the caller two newlines while telling them it is
	// text. Treat whitespace-only as nothing to read; the Class A branch of
	// `resolveContextUnavailableReason` then points at the original file,
	// which for these rows is exactly where the information actually is.
	const hasReadableText = body.trim().length > 0;

	const originalFile = await resolveOriginalFileLink(ctx);

	return jsonResult({
		id: ctx.id,
		projectId: ctx.projectId,
		type: ctx.type,
		title: resolveContextTitle(ctx),
		source: resolveContextProvider(ctx),
		filename: ctx.originalFilename,
		mimeType: ctx.mimeType,
		fileSizeBytes: ctx.fileSize,
		sourceUrl: ctx.sourceUrl,
		extractionStatus: ctx.extractionStatus,
		createdAt: ctx.createdAt,
		updatedAt: ctx.updatedAt,
		contentAvailable: hasReadableText,
		...(hasReadableText
			? {}
			: { unavailableReason: resolveContextUnavailableReason(ctx) }),
		content: page,
		contentLength: body.length,
		offset,
		returnedLength: page.length,
		truncated,
		...(truncated ? { nextOffset: offset + page.length } : {}),
		...(originalFile ? { originalFile } : {}),
	});
}

/**
 * Presign the original upload behind a context, when there is one. Returned
 * alongside the extracted text rather than instead of it — an image or a
 * diagram-heavy PDF extracts to little or nothing, and the caller needs a way
 * to reach the bytes. A presign failure is not fatal: the text still ships.
 */
async function resolveOriginalFileLink(ctx: {
	s3Path?: string | null;
	s3Bucket?: string | null;
	originalFilename?: string | null;
	mimeType?: string | null;
	fileSize?: number | null;
}): Promise<{
	filename: string | null;
	mimeType: string | null;
	sizeBytes: number | null;
	url: string;
	expiresAt: string;
} | null> {
	if (!ctx.s3Path) {
		return null;
	}

	try {
		const { config } = await import("@repo/config");
		const { getSignedUrl } = await import("@repo/storage");
		const { buildContentDisposition } = await import(
			"@repo/utils/attachment"
		);

		const filename = ctx.originalFilename || "context-file";
		const url = await getSignedUrl(ctx.s3Path, {
			bucket: ctx.s3Bucket ?? config.storage.bucketNames.projectContexts,
			expiresIn: CONTEXT_FILE_URL_EXPIRY_SECONDS,
			responseContentDisposition: buildContentDisposition(filename),
			responseContentType: ctx.mimeType ?? undefined,
		});

		return {
			filename: ctx.originalFilename ?? null,
			mimeType: ctx.mimeType ?? null,
			sizeBytes: ctx.fileSize ?? null,
			url,
			expiresAt: new Date(
				Date.now() + CONTEXT_FILE_URL_EXPIRY_SECONDS * 1000,
			).toISOString(),
		};
	} catch (error) {
		console.error(
			"[MCP Gateway] Failed to presign original context file:",
			error,
		);
		return null;
	}
}

async function handleListWorkspaces(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listWorkspaces } = await import("@repo/database");

	const result = await listWorkspaces({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		search: args.search as string | undefined,
		limit: Math.min((args.limit as number) ?? 20, 50),
		offset: (args.offset as number) ?? 0,
	});

	return jsonResult({
		workspaces: result.workspaces.map((w) => ({
			id: w.id,
			name: w.name,
			description: w.description,
			status: w.status,
			createdAt: w.createdAt,
			updatedAt: w.updatedAt,
		})),
		total: result.total,
		hasMore: result.hasMore,
	});
}

async function handleGetWorkspace(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getWorkspaceById } = await import("@repo/database");

	const workspaceId = args.workspaceId as string;
	if (!workspaceId) {
		return errorResult("workspaceId is required");
	}

	const workspace = await getWorkspaceById(
		workspaceId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!workspace) {
		return errorResult("Workspace not found or access denied");
	}

	return jsonResult({
		id: workspace.id,
		name: workspace.name,
		description: workspace.description,
		status: workspace.status,
		type: workspace.type,
		createdAt: workspace.createdAt,
		updatedAt: workspace.updatedAt,
	});
}

async function handleQueryWorkspace(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { hasWorkspaceAccess } = await import("@repo/database");

	const workspaceId = args.workspaceId as string;
	const query = args.query as string;
	if (!workspaceId || !query) {
		return errorResult("workspaceId and query are required");
	}

	const hasAccess = await hasWorkspaceAccess(
		workspaceId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!hasAccess) {
		return errorResult("Workspace not found or access denied");
	}

	// Use RAG: embed query then search workspace chunks
	try {
		const {
			generateEmbedding,
			generateSparseVector,
			searchWorkspaceChunks,
		} = await import("@repo/rag");

		// Embed the query through the RAG package's single entry point
		// (generateEmbedding → getAIEmbeddingModelWithMetadata →
		// resolveModelWithProvider("EMBEDDING") → getEmbeddingModel) — the SAME
		// resolver the workspace chunks were embedded with at ingest. This is the
		// one source of truth for the embedding provider+model, so the query and
		// the stored vectors always come from the same provider/model — and, for
		// Databricks/Azure BYOK, the correct serving URL (workspace host →
		// /serving-endpoints, Azure → /openai/deployments/.../embeddings +
		// api-version). The old hand-rolled createOpenAI bound its baseURL/key to
		// the tenant's DEFAULT provider (getRAGProviderConfig, no task type) while
		// ingest uses the dedicated embedding provider, so for a BYOK Databricks/
		// Azure tenant — or any tenant whose embedding provider ≠ default — it hit
		// the wrong host or a wrong vector space. Mirrors the other workspace-
		// search paths (workspaces/chat, api/v1/workspaces).
		const { embedding } = await generateEmbedding(query, {
			userId: session.userId,
			organizationId: session.organizationId || undefined,
		});

		const results = await searchWorkspaceChunks({
			workspaceId,
			userId: session.userId,
			organizationId: session.organizationId || undefined,
			queryEmbedding: embedding,
			querySparseVector: generateSparseVector(query),
			topK: Math.min((args.limit as number) ?? 10, 50),
			minSimilarity: 0.4,
		});

		return jsonResult({
			query,
			results: results.map((r) => ({
				documentId: r.documentId,
				filename: r.filename,
				score: r.score,
				chunkIndex: r.chunkIndex,
				pageNumber: r.pageNumber,
				headings: r.headings,
			})),
			totalResults: results.length,
		});
	} catch (error) {
		// Reflect the real cause in the primary message. generateEmbedding can
		// fail for reasons other than "RAG not set up": an AI usage/credit limit
		// was hit, or no embedding provider is configured. Branch on the error
		// name (each class sets a distinctive `name`) so we don't misattribute a
		// quota block to missing config; the raw reason is always kept in `error`.
		const reason =
			error instanceof Error ? error.message : "RAG query failed";
		const name = error instanceof Error ? error.name : "";
		const message =
			name === "AiUsageLimitExceededError" ||
			name === "AiCreditLimitExceededError"
				? `Semantic search is unavailable: ${reason}`
				: name === "AIProviderNotConfiguredError"
					? reason
					: "Semantic search is not configured for this workspace. RAG provider may not be set up.";
		return jsonResult({
			message,
			error: reason,
		});
	}
}

// ─── Workflow Handlers ──────────────────────────────────────────────────────

async function handleListWorkflows(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listWorkflows } = await import("@repo/database");

	const result = await listWorkflows({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		status: args.status as
			| "DRAFT"
			| "ACTIVE"
			| "PAUSED"
			| "ARCHIVED"
			| undefined,
		search: args.search as string | undefined,
		limit: Math.min((args.limit as number) ?? 20, 50),
		offset: (args.offset as number) ?? 0,
	});

	return jsonResult({
		workflows: result.workflows.map((w) => ({
			id: w.id,
			name: w.name,
			description: w.description,
			status: w.status,
			triggerType: w.triggerType,
			isPublished: !!w.publishedAt,
			createdAt: w.createdAt,
			updatedAt: w.updatedAt,
		})),
		total: result.total,
		hasMore: result.hasMore,
	});
}

async function handleGetWorkflow(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getWorkflowById } = await import("@repo/database");

	const workflowId = args.workflowId as string;
	if (!workflowId) {
		return errorResult("workflowId is required");
	}

	// getWorkflowById enforces tenant isolation via userId + organizationId
	const workflow = await getWorkflowById(
		workflowId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!workflow) {
		return errorResult("Workflow not found or access denied");
	}

	return jsonResult({
		id: workflow.id,
		name: workflow.name,
		description: workflow.description,
		status: workflow.status,
		triggerType: workflow.triggerType,
		isPublished: !!workflow.publishedAt,
		nodes: workflow.nodes,
		edges: workflow.edges,
		createdAt: workflow.createdAt,
		updatedAt: workflow.updatedAt,
	});
}

async function handleExecuteWorkflow(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getWorkflowById } = await import("@repo/database");

	const workflowId = args.workflowId as string;
	if (!workflowId) {
		return errorResult("workflowId is required");
	}

	// getWorkflowById enforces tenant isolation
	const workflow = await getWorkflowById(
		workflowId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!workflow) {
		return errorResult("Workflow not found or access denied");
	}
	if (!workflow.publishedAt) {
		return errorResult("Workflow must be published before execution");
	}

	try {
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		const executionId = `mcp-wf-${workflowId}-${Date.now()}`;

		await client.workflow.start("workflowBuilderExecution", {
			taskQueue: "workflow-builder",
			workflowId: executionId,
			args: [
				{
					workflowId,
					userId: session.userId,
					organizationId: session.organizationId || undefined,
					inputs: (args.inputs as Record<string, unknown>) ?? {},
					executionSource: "mcp-gateway",
				},
			],
		});

		return jsonResult({
			executionId,
			workflowId,
			status: "STARTED",
			message: `Workflow "${workflow.name}" execution started. Use fabric_get_workflow_execution to check status.`,
		});
	} catch (error) {
		return errorResult(
			`Failed to start workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

async function handleGetWorkflowExecution(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getWorkflowExecutionById } = await import("@repo/database");

	const executionId = args.executionId as string;
	if (!executionId) {
		return errorResult("executionId is required");
	}

	// getWorkflowExecutionById enforces tenant isolation
	const execution = await getWorkflowExecutionById(
		executionId,
		session.userId,
		session.organizationId || undefined,
	);
	if (!execution) {
		return errorResult("Execution not found or access denied");
	}

	return jsonResult({
		id: execution.id,
		workflowId: execution.workflowId,
		status: execution.status,
		startedAt: execution.startedAt,
		completedAt: execution.completedAt,
		output: execution.output,
		error: execution.error,
		duration: execution.duration,
	});
}

// ─── AI Chat Handlers ───────────────────────────────────────────────────────

async function handleListChats(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { db } = await import("@repo/database");

	const filter = tenantFilter(session);
	const limit = Math.min((args.limit as number) ?? 20, 50);

	const chats = await db.aiChat.findMany({
		where: filter,
		select: {
			id: true,
			title: true,
			createdAt: true,
			updatedAt: true,
		},
		orderBy: { updatedAt: "desc" },
		take: limit,
	});

	return jsonResult({ chats, count: chats.length });
}

// ─── Frames Handlers ───────────────────────────────────────────────────────

async function handleCreateFrame(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createFirstClassFrame } = await import(
		"@repo/temporal/frame-service"
	);
	const result = await createFirstClassFrame({
		args,
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		sourceRunType: "MCP_GATEWAY",
		sourceRunId: session.sessionId,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
}

async function handleCreateSlideshow(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createFirstClassFrame } = await import(
		"@repo/temporal/frame-service"
	);
	const result = await createFirstClassFrame({
		args: { ...args, kind: "slideshow" },
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		sourceRunType: "MCP_GATEWAY",
		sourceRunId: session.sessionId,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
}

async function handleUpdateFrame(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { updateFirstClassFrame } = await import(
		"@repo/temporal/frame-service"
	);
	const result = await updateFirstClassFrame({
		args,
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
}

async function handleGetFrame(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getFirstClassFrame } = await import("@repo/temporal/frame-service");
	const result = await getFirstClassFrame({
		args,
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
}

async function handleListFrames(
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listFirstClassFrames } = await import(
		"@repo/temporal/frame-service"
	);
	const result = await listFirstClassFrames({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});
	return jsonResult(result);
}

async function handleShareFrame(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { shareFirstClassFrame } = await import(
		"@repo/temporal/frame-service"
	);
	const result = await shareFirstClassFrame({
		args,
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
}

// ─── Connected Servers Handler ──────────────────────────────────────────────

async function handleListConnectedServers(
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listMcpConfigsForTenant } = await import("@repo/database");

	const configs = await listMcpConfigsForTenant({
		userId: session.userId,
		organizationId: session.organizationId,
	});

	const servers = configs
		.filter((c) => c.enabled)
		.map((c) => ({
			configId: c.id,
			displayName: c.displayName || c.mcpServer?.name || "Unknown",
			serverKey: c.mcpServer?.key,
			status: c.status,
			authType: c.authType,
			transport: c.transport || c.mcpServer?.transport,
			toolCount: c.toolCount,
			lastHealthCheck: c.lastHealthCheckAt,
		}));

	return jsonResult({ servers, count: servers.length });
}

// ─── Authority Handlers ─────────────────────────────────────────────────────

async function handleRequestAuthority(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createAuthorityRequest } = await import("@repo/database");

	const providers = args.providers as
		| Array<{
				providerKey: string;
				accessLevel: "READ" | "WRITE";
				reason?: string;
		  }>
		| undefined;

	if (!providers || !Array.isArray(providers) || providers.length === 0) {
		return errorResult(
			"providers is required: array of { providerKey, accessLevel }",
		);
	}

	const ttlMinutes = Math.min(
		Math.max((args.ttlMinutes as number) ?? 30, 1),
		480,
	);

	const result = await createAuthorityRequest({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		runType: "MCP_GATEWAY",
		runId: session.sessionId, // Bind authority to this specific gateway session
		ttlMinutes,
		grants: providers.map((p) => ({
			providerType: "MCP" as const,
			providerKey: p.providerKey,
			providerDisplayName: p.providerKey,
			accessLevel: p.accessLevel,
			metadata: p.reason ? { reason: p.reason } : undefined,
		})),
	});

	return jsonResult({
		authoritySessionId: result.session.id,
		status: result.session.status,
		expiresAt: result.session.expiresAt,
		ttlMinutes,
		grants: result.grants.map((g) => ({
			id: g.id,
			providerKey: g.providerKey,
			accessLevel: g.accessLevel,
			status: g.status,
		})),
		message:
			`Authority requested for ${providers.length} provider(s). ` +
			"Approve via the Fabric dashboard or API, then use fabric_check_authority to see status.",
	});
}

async function _handleApproveAuthority(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getAuthoritySession, approveAuthoritySession } = await import(
		"@repo/database"
	);

	const sessionId = args.sessionId as string;
	if (!sessionId) {
		return errorResult("sessionId is required");
	}

	const authSession = await getAuthoritySession(
		sessionId,
		session.userId,
		session.organizationId || undefined,
	);

	if (!authSession) {
		return errorResult("Authority session not found or access denied");
	}
	if (authSession.status !== "PENDING") {
		return errorResult(
			`Authority session is ${authSession.status}, can only approve PENDING sessions`,
		);
	}

	const approved = await approveAuthoritySession(
		sessionId,
		session.userId,
		(args.instructions as string) ?? undefined,
	);

	return jsonResult({
		authoritySessionId: sessionId,
		status: "ACTIVE",
		expiresAt: approved?.expiresAt,
		grants:
			approved?.grants.map((g) => ({
				id: g.id,
				providerKey: g.providerKey,
				accessLevel: g.accessLevel,
				status: g.status,
			})) ?? [],
		message:
			"Authority approved. Connected tools for the granted providers are now available.",
	});
}

async function handleRevokeAuthority(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getAuthoritySession, revokeAuthoritySession } = await import(
		"@repo/database"
	);

	const sessionId = args.sessionId as string;
	if (!sessionId) {
		return errorResult("sessionId is required");
	}

	const authSession = await getAuthoritySession(
		sessionId,
		session.userId,
		session.organizationId || undefined,
	);

	if (!authSession) {
		return errorResult("Authority session not found or access denied");
	}
	if (authSession.status !== "ACTIVE") {
		return errorResult(
			`Authority session is ${authSession.status}, can only revoke ACTIVE sessions`,
		);
	}

	await revokeAuthoritySession(sessionId);

	return jsonResult({
		authoritySessionId: sessionId,
		status: "REVOKED",
		message: "Authority revoked. All grants have been terminated.",
	});
}

async function handleCheckAuthority(
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { listAuthoritySessions } = await import("@repo/database");

	const result = await listAuthoritySessions({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		status: "ACTIVE",
		limit: 10,
	});

	// Also check for pending sessions
	const pending = await listAuthoritySessions({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		status: "PENDING",
		limit: 5,
	});

	return jsonResult({
		activeSessions: result.sessions.map((s) => ({
			id: s.id,
			runType: s.runType,
			status: s.status,
			expiresAt: s.expiresAt,
			grants: s.grants.map((g) => ({
				id: g.id,
				providerKey: g.providerKey,
				providerDisplayName: g.providerDisplayName,
				accessLevel: g.accessLevel,
				status: g.status,
				kind: g.kind,
			})),
		})),
		pendingSessions: pending.sessions.map((s) => ({
			id: s.id,
			runType: s.runType,
			status: s.status,
			expiresAt: s.expiresAt,
			grants: s.grants.map((g) => ({
				providerKey: g.providerKey,
				accessLevel: g.accessLevel,
				status: g.status,
			})),
		})),
		totalActive: result.total,
		totalPending: pending.total,
	});
}

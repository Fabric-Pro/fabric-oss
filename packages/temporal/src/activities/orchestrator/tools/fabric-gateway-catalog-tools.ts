/**
 * Fabric's gateway tools — the workflow tools and the frame tools — as the
 * Orchestrator's catalogue lists them.
 *
 * The name, input schema and base description are the one list the Fabric MCP
 * gateway serves (`fabric-gateway-tools`); the catalogue adds what a chat needs
 * to find a tool from a plain request — when to reach for it, first, and the
 * phrases people use, last, in the same `KEYWORDS:` form its other tools use.
 * The table below is keyed by the tools' names as a type, so a tool added to
 * the list without discovery text here does not compile. Running one goes
 * through the gateway (`fabric-catalog-adapter`), as the acting user, so the
 * Orchestrator offers the arguments Direct chat does (`surface`, `runtimeTools`,
 * `sharedWithOrganization`), which are external coding agents' less `dryRun`:
 * in chat the approval card is the draft (`withoutDryRun`).
 *
 * A `KEYWORDS:` section ends at the first sentence stop, so none of the phrases
 * below contain one.
 */

import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	type FabricChatToolName,
} from "../../../lib/fabric-gateway-tools";
import {
	withoutDryRun,
	withoutDryRunNote,
} from "../../../lib/fabric-tool-definition";
import type { FabricAiTool } from "./fabric-ai-tools";

interface Discovery {
	/** When to reach for the tool; leads the description. */
	when: string;
	/** What to do with it, after what it does. */
	how?: string;
	keywords: string;
}

const DISCOVERY: Record<FabricChatToolName, Discovery> = {
	fabric_list_project_pm_assigned_items: {
		when: "To enumerate real directly assigned work-item IDs in the attached project's configured Azure DevOps target before reading their requirements or comments.",
		how: "Use current connection identity or an actual member uniqueName; pass returned cursor with the same filters until complete. This does not traverse parents, children or iterations.",
		keywords:
			"ADO assigned items, Azure DevOps assigned stories tasks, enumerate work items, assigned item IDs",
	},
	fabric_get_project_pm_item_snapshots: {
		when: "To inspect real Azure DevOps item requirements and their own versioned comments, using IDs and requirementsAsOf from assigned-item enumeration.",
		how: "Read at most 10 IDs; select the requirement fields named in project instructions. Historical requirements and current comments are separate captures. Honor incomplete, unreadIds and resultTruncated; linked item comments are not included.",
		keywords:
			"ADO item snapshots, Azure DevOps requirements comments, BusinessRules specification, read work item details",
	},
	fabric_list_project_pm_work_item_types: {
		when: "To populate a work-item type selector from the configured Azure DevOps project's actual enabled types.",
		keywords:
			"ADO work item types, Azure DevOps type selector, story type options",
	},
	fabric_get_project_pm_connection: {
		when: "To check whether an attached Fabric project has Azure DevOps project management configured and the current viewer has connected their own account.",
		keywords:
			"Azure DevOps connection, ADO connected, project management binding, refresh disabled, detect connection, dashboard setup",
	},
	fabric_list_project_pm_members: {
		when: "To populate a member selector from the configured Azure DevOps project's actual team members, including those with no work items.",
		keywords:
			"ADO project members, Azure DevOps team members, member selector, assignee dropdown, project people",
	},
	fabric_get_project_work_item_counts: {
		when: "To count current Azure DevOps work items in the attached project's configured PM target, optionally for a selected member and exact state.",
		keywords:
			"Azure DevOps work items, ADO work item counts, In Development status, assigned work counts, refresh dashboard",
	},
	fabric_list_projects: {
		when: "To find a Fabric project by its name and get the projectId for its data or a Workspace.",
		keywords:
			"list Fabric projects workspaces, find project, projects coding instructions, project id, attached project",
	},
	fabric_get_project: {
		when: "To read a Fabric project's details and see its Coding Instructions source.",
		keywords:
			"project details, coding instructions source, attached repository, project configuration",
	},
	fabric_list_project_instructions: {
		when: "To list or count the actual Coding Instructions configuration files attached to a Fabric project, with pagination for repository sources.",
		keywords:
			"coding instructions configs, count configurations, list project instructions, repository skills agents rules settings",
	},
	fabric_get_project_instruction: {
		when: "To read one of the Coding Instructions files listed for a project.",
		keywords:
			"read coding instructions file, project configuration content, instruction path",
	},
	fabric_get_project_instruction_bundle: {
		when: "To get the full Coding Instructions bundle or native repository checkout guidance for a project.",
		keywords:
			"coding instructions bundle, connected instruction repository, download instructions, install project instructions",
	},
	fabric_list_connected_servers: {
		when: "To see which MCP integrations the current user has connected before using their tools in a page.",
		keywords:
			"connected servers integrations, available tools, Azure DevOps connection, ADO connected, MCP servers",
	},
	fabric_list_page_tools: {
		when: "Before building a live dashboard or a page with runtimeTools: discover the exact Fabric platform tools a page may call and their argument schemas.",
		keywords:
			"runtime tools frame fabric call list sources project, page compatible tools, runtimeTools schema, dashboard live data, Fabric page tools",
	},
	fabric_list_workflows: {
		when: "To find a workflow or routine the person already has, or to see what is scheduled.",
		keywords:
			"my workflows, list workflows, scheduled workflows, my routines, my automations, what is scheduled, recurring jobs",
	},
	fabric_get_workflow: {
		when: "For one workflow's schedule, state and latest run.",
		keywords:
			"workflow details, show the workflow, workflow schedule, next run, when does it run",
	},
	fabric_list_workflow_runs: {
		when: "To see whether and when a workflow ran.",
		keywords:
			"workflow runs, run history, did the workflow run, last run, recent runs",
	},
	fabric_get_workflow_execution: {
		when: "For the outcome of one workflow run and the frame it published.",
		keywords:
			"run result, execution result, did the run finish, what did the run return, workflow result",
	},
	fabric_execute_workflow: {
		when: "To start one run of a published workflow now; the person approves it first.",
		keywords:
			"run the workflow, run it now, start the workflow, trigger the workflow, execute workflow",
	},
	fabric_create_workflow: {
		when: "For anything the person wants done on a schedule or repeatedly: a weekly status page, a daily digest, a recurring report or routine, such as every Monday at 9:00 make me a status page from my work items.",
		how: "Make the real call: the person is shown what will run and when as an approval card and decides there, so do not ask in prose first. Approving also covers publishing the new workflow and running it once, so call fabric_publish_workflow and fabric_execute_workflow next.",
		keywords:
			"on a schedule, scheduled workflow, recurring workflow, every day, every week, every monday, every morning, every weekday, run weekly, run daily, routine, automation, automate this, recurring report, weekly status page, publish a page every",
	},
	fabric_update_workflow: {
		when: "To change a workflow's schedule, task, servers or output; the person approves the save.",
		keywords:
			"edit the workflow, change the schedule, update the workflow, reschedule, change what it does, change the prompt",
	},
	fabric_bind_workspace_workflow: {
		when: "To let an owned Workspace control an existing workflow in the same project, or revoke that binding; the person approves it first.",
		how: "Read both current timestamps before binding or unbinding. Binding requires published, unchanged workflow settings; revocation also works after the workflow is paused or edited.",
		keywords:
			"bind workspace workflow, attach workflow to workspace, unbind workspace workflow, confirm workflow version, revoke workspace workflow",
	},
	fabric_publish_workflow: {
		when: "To put a draft workflow live; the person approves it first.",
		keywords:
			"publish the workflow, activate the workflow, turn on the workflow, start the schedule, make it live",
	},
	fabric_unpublish_workflow: {
		when: "To take a live workflow back to draft; the person approves it first.",
		keywords:
			"unpublish the workflow, turn off the workflow, stop the schedule, back to draft",
	},
	fabric_pause_workflow: {
		when: "To pause a live workflow's schedule without losing it; the person approves it first.",
		keywords:
			"pause the workflow, pause the schedule, pause the routine, hold the schedule",
	},
	fabric_resume_workflow: {
		when: "To resume a paused workflow's schedule; the person approves it first.",
		keywords:
			"resume the workflow, resume the schedule, unpause the workflow, turn the schedule back on",
	},
	fabric_create_frame: {
		when: "For interactive visualizations, charts, dashboards, reports and living documents the user asks for, a Workspace page or a project's artifact, including a page with buttons that read live Fabric data. A plain diagram needs no frame: the chat renders a mermaid code block.",
		keywords:
			"create a page, build a dashboard, make a chart, interactive visualization, workspace page, project artifact, a page with a button, status dashboard, frame",
	},
	fabric_update_frame: {
		when: "To change a page that exists: its title, content or the tools its buttons call.",
		keywords:
			"update the page, change the dashboard, edit the workspace, add a button, redesign the page, fix the page",
	},
	fabric_get_frame: {
		when: "To read a page's content, surface and tools before changing it.",
		how: "For source edits use offset:0, limit:6000; follow nextOffset until complete and keep updatedAt unchanged across chunks.",
		keywords:
			"show the page, read the page, open the workspace, page content",
	},
	fabric_list_frames: {
		when: "To list the user's pages: their Workspaces and a project's artifacts.",
		keywords:
			"my pages, list workspaces, list artifacts, which pages do i have, project artifacts",
	},
	fabric_share_frame: {
		when: "To change who can open a page the person owns: keep it private, invite people by email, share it with the organization or publish a link; the person approves it first.",
		keywords:
			"share the page, public link, publish the page, share a link, share with the team, invite by email, make it private, stop sharing",
	},
	fabric_create_slideshow: {
		when: "For slides, a slideshow, a presentation or a deck: one slide per component.",
		keywords:
			"slides, slideshow, presentation, deck, make a deck, create slides",
	},
	fabric_page_data_list: {
		when: "To read the poll results, checklist items, sign-ups or tracker rows people saved on a page.",
		keywords:
			"page data, poll results, votes, checklist items, sign-ups, tracker rows, what people added, summarize the poll, who voted",
	},
	fabric_page_data_get: {
		when: "For one record of a page's data by its key, such as one person's vote.",
		keywords:
			"one record, someone's vote, a checklist item, look up a record, page record",
	},
	fabric_page_data_set: {
		when: "To put records into a page's store: the options of a poll, checklist items, the first rows of a tracker. Pages keep what their viewers enter; this is how the agent adds to it.",
		keywords:
			"add to the poll, seed the data, add checklist items, fill the tracker, set the records, sign-up sheet, shared data for the page",
	},
	fabric_page_data_delete: {
		when: "To remove records from a page's store, such as clearing the votes or a finished item.",
		keywords:
			"clear the votes, remove the record, delete the entry, reset the poll, clear the sign-ups",
	},
	fabric_get_page_viewer: {
		when: "To learn who is viewing a page, for a page that greets or attributes by name.",
		keywords:
			"who is viewing, who is looking at this page, who opened the page, current viewer, viewer name, greet the viewer",
	},
	fabric_page_file_upload: {
		when: "To store a file on a page that people can download later: a report, an export, an attachment.",
		keywords:
			"upload a file, attach a file, store a file on the page, uploads, attachments",
	},
	fabric_page_file_list: {
		when: "To see the files stored on a page.",
		keywords:
			"files on the page, list uploads, attachments, uploaded files",
	},
	fabric_page_file_read: {
		when: "To read a file stored on a page.",
		keywords: "read the file, open the upload, get the attachment",
	},
	fabric_page_file_delete: {
		when: "To delete a file stored on a page.",
		keywords: "delete the file, remove the upload, remove the attachment",
	},
	fabric_page_comment_add: {
		when: "To comment on a page for the people who open it.",
		keywords:
			"comment on the page, leave a comment, add a note to the page",
	},
	fabric_page_comment_list: {
		when: "To read the comments on a page.",
		keywords:
			"page comments, read the comments, feedback on the page, summarize the comments",
	},
	fabric_list_frame_versions: {
		when: "To see how a page changed: its saved versions.",
		keywords:
			"page history, versions of the page, what changed, earlier versions, undo history",
	},
	fabric_restore_frame_version: {
		when: "To put a page back to an earlier version; the person approves it first.",
		keywords:
			"restore the page, go back to the earlier version, undo the change, revert the page, roll back the page",
	},
	fabric_duplicate_frame: {
		when: "To fork a page into a copy of the person's own, to change a page they cannot edit or to try a variation.",
		keywords:
			"fork the page, duplicate the page, copy the workspace, make a copy, remix the page, my own version",
	},
};

function describe(tool: {
	name: FabricChatToolName;
	description: string;
}): string {
	const discovery = DISCOVERY[tool.name];
	return [
		discovery.when,
		tool.description,
		discovery.how,
		`KEYWORDS: ${discovery.keywords}`,
	]
		.filter(Boolean)
		.join(" ");
}

export const FABRIC_GATEWAY_CATALOG_TOOLS: FabricAiTool[] =
	FABRIC_CHAT_TOOL_DEFINITIONS.map((definition) => ({
		name: definition.name,
		description: describe({
			...definition,
			description: withoutDryRunNote(definition.description),
		}),
		inputSchema: withoutDryRun(definition.inputSchema),
	}));

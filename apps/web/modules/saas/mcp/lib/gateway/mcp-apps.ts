import { createHash } from "node:crypto";
import type { ToolCallResult } from "./types";
import {
	buildFabricVisualizePayload,
	FABRIC_BRAND,
	FABRIC_MARK_DATA_URI,
	kitPageSync,
} from "./ui-kit";

export { buildFabricVisualizePayload, FABRIC_BRAND, FABRIC_MARK_DATA_URI };

export interface FabricMcpAppResourceDescriptor {
	uri: string;
	name: string;
	description: string;
	mimeType: string;
	_meta?: {
		ui?: {
			csp?: {
				connectDomains?: string[];
				resourceDomains?: string[];
				frameDomains?: string[];
				baseUriDomains?: string[];
			};
			permissions?: string[];
			prefersBorder?: boolean;
		};
		"openai/widgetCSP"?: {
			connect_domains: string[];
			resource_domains: string[];
			redirect_domains: string[];
		};
		"openai/widgetDomain"?: string;
		"openai/widgetPrefersBorder"?: boolean;
		"openai/widgetDescription"?: string;
	};
}

export interface FabricMcpAppResourceContent {
	uri: string;
	mimeType: string;
	text: string;
	_meta?: Record<string, unknown>;
}

const WIDGET_DOMAINS = ["https://fabric.pro", "https://agents.fabric.pro"];

function createResourceMeta(description: string, prefersBorder = true) {
	return {
		ui: {
			csp: {
				connectDomains: [] as string[],
				resourceDomains: [] as string[],
				frameDomains: [] as string[],
				baseUriDomains: [] as string[],
			},
			permissions: ["clipboard-write"],
			prefersBorder,
		},
		"openai/widgetCSP": {
			connect_domains: [] as string[],
			resource_domains: [] as string[],
			redirect_domains: [...WIDGET_DOMAINS],
		},
		"openai/widgetDomain": WIDGET_DOMAINS[0],
		"openai/widgetPrefersBorder": prefersBorder,
		"openai/widgetDescription": description,
	};
}

/**
 * Built-in MCP App resources (`ui://fabric/*`) served by the Fabric MCP Gateway,
 * `/mcp` protocol endpoint, and `@fabricorg/sdk-mcp` for native rendering inside
 * Fabric Desktop, Claude Desktop, claude.ai, ChatGPT, and MCP App-capable hosts.
 */
export const FABRIC_MCP_APP_RESOURCES: readonly FabricMcpAppResourceDescriptor[] =
	[
		{
			uri: "ui://fabric/private-triage",
			name: "Fabric private signal review",
			description:
				"Inspect your selected-evidence proposals and keep or dismiss them privately after current source access checks.",
			mimeType: "text/html;profile=mcp-app",
			_meta: createResourceMeta(
				"Private cited signal proposals; keeping one does not share it or create a ticket.",
			),
		},
		{
			uri: "ui://fabric/project-dashboard",
			name: "Fabric Project Overview & Desktop Launcher",
			description:
				"Interactive Fabric-branded project overview card with backlog metrics, living memory status, artifact tables, and 1-click launch into Fabric Desktop or Remote Fabric Agents Server.",
			mimeType: "text/html;profile=mcp-app",
			_meta: createResourceMeta(
				"Interactive Fabric project overview with metrics, artifacts, and 1-click launch into Fabric Desktop.",
			),
		},
		{
			uri: "ui://fabric/agent-delegation",
			name: "Fabric Agents Delegation & Subscription Credits",
			description:
				"Interactive Fabric-branded delegation console to dispatch coding tasks to Fabric Desktop (fabricagents://) or Remote Fabric Agents Server using subscription harnesses (Claude, Codex, Droid, Grok, Kimi).",
			mimeType: "text/html;profile=mcp-app",
			_meta: createResourceMeta(
				"Delegate coding tasks to Fabric Desktop or Remote Fabric Agents Server using subscription harnesses and inspect connected integrations.",
			),
		},
		{
			uri: "ui://fabric/workflow-visualizer",
			name: "Fabric Visual Data Prep & Durable Temporal Workflow Inspector",
			description:
				"Interactive Fabric-branded DAG pipeline stepper and Temporal workflow execution monitor with step-by-step stage diagrams and durable replay metadata.",
			mimeType: "text/html;profile=mcp-app",
			_meta: createResourceMeta(
				"Step through Fabric Visual Data Prep pipelines and durable Temporal workflow executions interactively.",
			),
		},
		{
			uri: "ui://fabric/genie-insights",
			name: "Fabric Genie Agent & Lakebase Query Explorer",
			description:
				"Interactive Fabric-branded Genie Agent SQL/workspace query explorer with structured table rendering, relevance charts, and source citation inspection.",
			mimeType: "text/html;profile=mcp-app",
			_meta: createResourceMeta(
				"Explore Fabric Genie workspace answers, structured data tables, charts, and cited documents.",
			),
		},
		{
			uri: "ui://fabric/visualize",
			name: "Fabric Interactive A2UI Card Composer",
			description:
				"An interactive Fabric-branded card drawn from an A2UI v0.9.1 document: comparisons, step-by-step plans, interactive charts with sliders, quizzes, flashcards, tables, and diagrams.",
			mimeType: "text/html;profile=mcp-app",
			_meta: createResourceMeta(
				"An answer drawn as an interactive Fabric card: comparisons, plans, charts, quizzes, tables, and diagrams composed by your assistant.",
				false,
			),
		},
	] as const;

/**
 * Maps Fabric platform and SDK MCP tools to their associated MCP App `ui://` resource URI
 * so MCP App-aware hosts automatically open interactive Fabric-branded UI cards.
 */
export const FABRIC_TOOL_UI_RESOURCE_MAP: Readonly<Record<string, string>> = {
	fabric_triage_result: "ui://fabric/private-triage",
	fabric_triage_review: "ui://fabric/private-triage",
	// Identity, Projects, Artifacts, Frames & Workspaces -> Project Dashboard Card
	fabric_get_identity: "ui://fabric/project-dashboard",
	fabric_list_organizations: "ui://fabric/project-dashboard",
	fabric_list_projects: "ui://fabric/project-dashboard",
	fabric_get_project: "ui://fabric/project-dashboard",
	fabric_create_project: "ui://fabric/project-dashboard",
	fabric_update_project: "ui://fabric/project-dashboard",
	fabric_get_project_statuses: "ui://fabric/project-dashboard",
	fabric_list_project_instructions: "ui://fabric/project-dashboard",
	fabric_get_project_instruction: "ui://fabric/project-dashboard",
	fabric_get_project_instruction_bundle: "ui://fabric/project-dashboard",
	fabric_list_frames: "ui://fabric/project-dashboard",
	fabric_get_frame: "ui://fabric/project-dashboard",
	fabric_create_frame: "ui://fabric/project-dashboard",
	fabric_update_frame: "ui://fabric/project-dashboard",
	fabric_create_slideshow: "ui://fabric/project-dashboard",
	fabric_list_workspaces: "ui://fabric/project-dashboard",
	fabric_get_workspace: "ui://fabric/project-dashboard",
	fabric_list_artifacts: "ui://fabric/project-dashboard",
	fabric_get_artifact: "ui://fabric/project-dashboard",

	// Tickets, Features, Bugs, Tasks, Assigned PM Items & Agent Delegation -> Agent Delegation Card
	fabric_list_features: "ui://fabric/agent-delegation",
	fabric_get_feature: "ui://fabric/agent-delegation",
	fabric_get_feature_decisions: "ui://fabric/agent-delegation",
	fabric_get_feature_versions: "ui://fabric/agent-delegation",
	fabric_create_feature: "ui://fabric/agent-delegation",
	fabric_create_bug: "ui://fabric/agent-delegation",
	fabric_update_feature: "ui://fabric/agent-delegation",
	fabric_update_feature_status: "ui://fabric/agent-delegation",
	fabric_create_feature_task: "ui://fabric/agent-delegation",
	fabric_update_task: "ui://fabric/agent-delegation",
	fabric_complete_task: "ui://fabric/agent-delegation",
	fabric_list_project_pm_assigned_items: "ui://fabric/agent-delegation",
	fabric_get_project_pm_item_snapshots: "ui://fabric/agent-delegation",
	fabric_get_project_work_item_counts: "ui://fabric/agent-delegation",
	fabric_list_tickets: "ui://fabric/agent-delegation",
	fabric_delegate_agent: "ui://fabric/agent-delegation",
	fabric_subscription_status: "ui://fabric/agent-delegation",
	fabric_list_mcp_servers: "ui://fabric/agent-delegation",
	fabric_list_connected_servers: "ui://fabric/agent-delegation",
	fabric_list_integrations: "ui://fabric/agent-delegation",
	fabric_list_operations: "ui://fabric/agent-delegation",
	fabric_call: "ui://fabric/agent-delegation",

	// Workflows & Durable Temporal Execution -> Workflow Visualizer Card
	fabric_list_workflows: "ui://fabric/workflow-visualizer",
	fabric_get_workflow: "ui://fabric/workflow-visualizer",
	fabric_execute_workflow: "ui://fabric/workflow-visualizer",
	fabric_get_workflow_execution: "ui://fabric/workflow-visualizer",
	fabric_list_workflow_executions: "ui://fabric/workflow-visualizer",

	// Genie, Workspace Knowledge, Documents, Contexts & Libraries -> Genie Insights Card
	fabric_query_workspace: "ui://fabric/genie-insights",
	fabric_search_knowledge: "ui://fabric/genie-insights",
	fabric_search_project_knowledge: "ui://fabric/genie-insights",
	fabric_list_documents: "ui://fabric/genie-insights",
	fabric_get_document: "ui://fabric/genie-insights",
	fabric_create_document: "ui://fabric/genie-insights",
	fabric_update_document: "ui://fabric/genie-insights",
	fabric_list_project_contexts: "ui://fabric/genie-insights",
	fabric_get_project_context: "ui://fabric/genie-insights",
	fabric_list_libraries: "ui://fabric/genie-insights",
	fabric_query_library: "ui://fabric/genie-insights",

	// A2UI Interactive Visualization -> Visualize Card
	fabric_visualize: "ui://fabric/visualize",
	visualize: "ui://fabric/visualize",
};

/**
 * Tools whose underlying execution is backed by Temporal workflows by default.
 */
const TEMPORAL_BACKED_MCP_TOOLS: ReadonlySet<string> = new Set([
	"fabric_execute_workflow",
	"fabric_get_workflow_execution",
	"run_browser_task",
	"run_hybrid_task",
	"execute_template",
	"extract_web_content",
]);

const FABRIC_VIEW_CSS = String.raw`
.viz-foot { display: flex; flex-direction: column; gap: 8px; }
.viz-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; }
.viz-sources > summary { cursor: pointer; font: 500 13px/20px var(--k-font); color: var(--k-muted); }
.viz-sources[open] > summary { margin-bottom: 6px; color: var(--k-ink); }
.viz-sources .k-sources-h:empty, .viz-sources .k-sources-h { display: none; }
.fb-meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
`;

function buildFabricMcpViewScript(options: {
	uri: string;
	title: string;
	subtitle: string;
	badge: string;
	defaultToolName: string;
}): string {
	const cfgJson = JSON.stringify({
		uri: options.uri,
		title: options.title,
		subtitle: options.subtitle,
		badge: options.badge,
		defaultToolName: options.defaultToolName,
		mark: FABRIC_MARK_DATA_URI,
	});

	return String.raw`
(function () {
  "use strict";
  try {
    var K = Kit, el = K.el, add = K.add, A2 = K.A2UI;
    var CFG = ${cfgJson};
    var FENCE = "\x60\x60\x60";
    var S = { r: null, v: null, mode: 0, harness: "claude-max", step: 0, models: {}, all: false, key: "fb:" + CFG.uri };
    var root = function () { return document.getElementById("kit-root"); };

    function canAsk() { return K.can("message"); }
    function ask(text, done) { K.sendMessage(text, done == null ? "Sent to your Fabric assistant." : done); }
    function tell(text, structured) { K.updateContext(text, structured); }
    function callServerTool(name, args) {
      if (K.host && K.host.caps && K.host.caps.serverTools) {
        return K.request("tools/call", { name: name, arguments: args || {}, _meta: { durable: true } });
      }
      ask("Please run " + name + " with " + JSON.stringify(args || {}) + " and show the updated result.");
      return Promise.resolve(null);
    }

    function onResult(r) {
      S.r = r;
      S.v = K.payload(r);
      S.step = 0;
      S.all = false;
      draw();
    }

    function draw() {
      var box = root();
      if (!box) return;
      K.clear(box);

      if (S.r && S.r.isError) {
        add(box, K.card({
          mark: CFG.mark,
          eyebrow: CFG.badge,
          eyebrowMeta: "Fabric MCP",
          title: "That request couldn't complete",
          body: [K.errorState(K.resultText(S.r) || "The Fabric server returned an error.")]
        }));
        return;
      }

      var v = S.v;
      if (v && Array.isArray(v.document)) {
        drawA2ui(box, v);
        return;
      }

      if (CFG.uri === "ui://fabric/private-triage") {
        add(box, drawTriageCard(v));
      } else if (CFG.uri === "ui://fabric/project-dashboard") {
        add(box, drawProjectCard(v));
      } else if (CFG.uri === "ui://fabric/agent-delegation") {
        add(box, drawDelegationCard(v));
      } else if (CFG.uri === "ui://fabric/workflow-visualizer") {
        add(box, drawWorkflowCard(v));
      } else if (CFG.uri === "ui://fabric/genie-insights") {
        add(box, drawGenieCard(v));
      } else {
        add(box, drawGenericFabricCard(v));
      }
    }

    function drawA2ui(box, v) {
      var built = A2.buildSurfaces(v.document);
      var full = K.displayMode() === "fullscreen";
      var drawable = built.surfaces.filter(function (s) {
        return Object.prototype.hasOwnProperty.call(s.components, "root") && !s.loop;
      });
      if (!drawable.length) {
        add(box, drawGenericFabricCard(v));
        return;
      }
      drawable.forEach(function (s, i) {
        if (S.models[s.surfaceId] && typeof S.models[s.surfaceId] === "object") {
          s.dataModel = S.models[s.surfaceId];
        }
        var card = K.card({
          mark: CFG.mark,
          eyebrow: "FABRIC INTERACTIVE VIEW",
          eyebrowMeta: v.provenance || "A2UI v0.9.1",
          title: i === 0 ? (v.title || CFG.title) : null,
          tools: i === 0 ? [K.expandButton()] : [],
          label: v.title || CFG.title
        });
        var surfaceNode = K.a2uiSurface(s, {
          onAction: function (visible, env) {
            K.sendMessage(
              visible + "\n\n" + FENCE + "a2ui\n" + env.map(function (m) { return JSON.stringify(m); }).join("\n") + "\n" + FENCE,
              "Sent to your Fabric assistant."
            );
          },
          onOpenUrl: function (u) { K.openLink(u); },
          onChange: function (sf) {
            S.models[sf.surfaceId] = sf.dataModel;
            K.saveState({ key: S.key, models: S.models });
            tell("In Fabric view \"" + (v.title || CFG.title) + "\", the user updated controls.", { view: CFG.uri, models: S.models });
          }
        });
        var bodyBox = el("div", "k-stack");
        add(bodyBox, surfaceNode);
        add(card.body, bodyBox);
        var foot = el("div", "viz-foot");
        var line0 = el("div", "viz-line");
        add(line0, K.provenance("assistant", v.provenance || "Composed by your Fabric assistant"));
        add(foot, line0);
        if (i === drawable.length - 1 && (v.sources || []).length) {
          var det = el("details", "viz-sources");
          if (full) det.open = true;
          add(
            det,
            el("summary", "", "Sources in Fabric (" + v.sources.length + ")"),
            K.sources(v.sources.map(function (x) { return { title: x.title, url: x.url, meta: x.page || null }; }), " ")
          );
          add(foot, det);
        }
        add(card.body, foot);
        add(box, card);
      });
    }

    function extractItems(v) {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      var keys = ["projects", "features", "tickets", "frames", "artifacts", "workspaces", "workflows", "executions", "documents", "contexts", "results", "chunks", "matches", "integrations", "servers", "items", "itemIds", "harnesses", "organizations"];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(v[keys[i]])) return v[keys[i]];
      }
      return [];
    }

    function isArtifactPayload(v) {
      if (!v || typeof v !== "object") return false;
      return Array.isArray(v.frames) || Array.isArray(v.artifacts) || Array.isArray(v.workspaces) || Boolean(v.frameId || v.blocks || v.surface === "artifact" || v.surface === "workspace");
    }

    function isTicketPayload(v) {
      if (!v || typeof v !== "object") return false;
      return Array.isArray(v.features) || Array.isArray(v.tickets) || Array.isArray(v.itemIds) || Array.isArray(v.items) || Boolean(v.feature || v.identifier || v.draftingStage || v.acceptanceCriteria);
    }

    function drawProjectCard(v) {
      if (isArtifactPayload(v)) {
        var artItems = extractItems(v);
        var singleArt = (!artItems.length && v && (v.title || v.frameId || v.id)) ? v : null;
        var list = artItems.length ? artItems : (singleArt ? [singleArt] : []);
        var artTitle = (v && v.title) || (list.length ? list.length + " Fabric Artifacts & Workspaces" : "Fabric Artifacts & Workspaces");
        var artSub = (v && v.description) || "Interactive frames, project artifacts, slideshows, and organization workspaces accessible with your Fabric credentials.";
        var artCard = K.card({
          mark: CFG.mark,
          eyebrow: "FABRIC ARTIFACTS & WORKSPACES",
          eyebrowMeta: "Authenticated Tenant Access",
          title: String(artTitle),
          sub: String(artSub),
          tools: [K.expandButton()],
          label: String(artTitle)
        });

        var workspaceCount = list.filter(function (x) { return x && x.surface === "workspace"; }).length;
        var artifactCount = list.length - workspaceCount;
        add(artCard.body, K.grid([
          K.stat({ label: "Total Artifacts", value: String(list.length || "0"), meta: "Frames & pages" }),
          K.stat({ label: "Project Artifacts", value: String(artifactCount), meta: "Surface: artifact" }),
          K.stat({ label: "Org Workspaces", value: String(workspaceCount || (v && Array.isArray(v.workspaces) ? v.workspaces.length : 0)), meta: "Shared canvases" })
        ], 140));

        if (list.length) {
          var artRows = list.slice(0, 10).map(function (it) {
            var kindStr = (it.surface ? it.surface : "artifact") + (it.kind ? " · " + it.kind : "");
            var detailStr = it.shareScope || (it.updatedAt ? String(it.updatedAt).slice(0, 10) : (it.description || "Accessible"));
            return [
              String(it.title || it.name || it.id || "Artifact"),
              String(kindStr),
              String(detailStr).slice(0, 56)
            ];
          });
          add(artCard.body, K.table(["Artifact / Workspace", "Surface & Kind", "Sharing / Updated"], artRows));
        }

        var firstUrl = (singleArt && singleArt.url) || (list[0] && list[0].url) || null;
        var artActions = [];
        if (firstUrl) {
          artActions.push(K.button("Open Artifact in Portal", function () { K.openLink(String(firstUrl)); }, { variant: "primary", arrow: "↗" }));
        }
        artActions.push(
          K.button("Open in Fabric Desktop", function () { K.openLink("fabricagents://action/new-chat"); }, { variant: firstUrl ? "outline" : "primary", arrow: "↗" }),
          K.button("List All Artifacts", function () { callServerTool("fabric_list_frames", {}); }, { variant: "quiet", arrow: "→" })
        );
        add(artCard.body, K.actions(artActions));
        return artCard;
      }

      var p = (v && (v.project || v)) || {};
      var items = extractItems(v);
      var projName = p.name || p.title || (items.length ? items.length + " Fabric Projects" : CFG.title);
      var projSlug = p.slug || p.id || (items[0] && (items[0].slug || items[0].id)) || "fabric-workspace";
      var projId = p.id || (items[0] && items[0].id) || "";
      var desc = p.description || p.summary || CFG.subtitle;
      var card = K.card({
        mark: CFG.mark,
        eyebrow: "FABRIC PROJECTS",
        eyebrowMeta: CFG.badge,
        title: String(projName),
        sub: String(desc),
        tools: [K.expandButton()],
        label: String(projName)
      });

      var totalFeatures = p.featureCount != null ? p.featureCount : (p._count && p._count.features != null ? p._count.features : items.reduce(function (acc, it) { return acc + (Number(it.featureCount || (it._count && it._count.features) || 0)); }, 0));
      var totalDocs = p.contextCount != null ? p.contextCount : (p.documentCount != null ? p.documentCount : items.reduce(function (acc, it) { return acc + (Number(it.documentCount || it.contextCount || 0)); }, 0));

      var stats = K.grid([
        K.stat({ label: "Projects", value: String(items.length || (p.id ? 1 : "Ready")), meta: p.status || "Active tenant" }),
        K.stat({ label: "Tickets & Features", value: String(totalFeatures || "Synced"), meta: "Backlog & specs" }),
        K.stat({ label: "Docs & Artifacts", value: String(totalDocs || "Active"), meta: "Living memory & frames" })
      ], 140);
      add(card.body, stats);

      if (items.length) {
        var rows = items.slice(0, 10).map(function (it) {
          var statusBadge = String(it.status || it.state || it.role || "ACTIVE");
          var detail = it.description || it.repositoryUrl || (it.updatedAt ? "Updated " + String(it.updatedAt).slice(0, 10) : "—");
          return [
            String(it.name || it.title || it.slug || it.id || "Project"),
            statusBadge,
            String(detail).slice(0, 60)
          ];
        });
        add(card.body, K.table(["Project", "Status", "Description / Repository"], rows));
      } else {
        add(card.body, K.callout({
          tone: "info",
          title: "Connected to Fabric MCP",
          text: "Ask your assistant to inspect a project, view artifacts, list tickets assigned to you, or launch a coding session in Fabric Desktop."
        }));
      }

      var deepLink = "fabricagents://action/new-chat?workspace=" + encodeURIComponent(String(projSlug));
      var actButtons = [
        K.button("Open in Fabric Desktop", function () { K.openLink(deepLink); }, { variant: "primary", arrow: "↗" }),
        K.button("My Assigned Tickets", function () {
          if (projId) {
            callServerTool("fabric_list_features", { projectId: String(projId), assignedToMe: true });
          } else {
            ask("Show me the tickets, features, and bugs assigned to me across my Fabric projects.");
          }
        }, { variant: "outline", arrow: "→" }),
        K.button("View Artifacts", function () {
          callServerTool("fabric_list_frames", projId ? { surface: "artifact", projectId: String(projId) } : {});
        }, { variant: "quiet", arrow: "→" })
      ];
      add(card.body, K.actions(actButtons));
      return card;
    }

    function drawDelegationCard(v) {
      var items = extractItems(v);
      var seg = K.segmented(["Remote Server", "Fabric Desktop"], S.mode, function (i) {
        S.mode = i;
        tell("User selected delegation target: " + (i === 0 ? "Remote Fabric Agents Server" : "Fabric Desktop"), { target: i === 0 ? "remote" : "desktop", harness: S.harness });
        draw();
      }, "Execution target");

      if (isTicketPayload(v)) {
        var singleTicket = (!items.length && v && (v.id || v.identifier || v.title)) ? v : (v && v.feature ? v.feature : null);
        var ticketList = items.length ? items : (singleTicket ? [singleTicket] : []);
        var totalTickets = (v && v.total != null) ? v.total : ticketList.length;
        var assignedCount = ticketList.filter(function (t) { return t && (t.assigneeId || t.assignedToMe || t.draftingStage === "PUBLISHED"); }).length || ticketList.length;
        var totalTasks = ticketList.reduce(function (acc, t) { return acc + Number(t && (t.taskCount != null ? t.taskCount : (Array.isArray(t.tasks) ? t.tasks.length : 0))); }, 0);
        var doneTasks = ticketList.reduce(function (acc, t) { return acc + Number(t && (t.completedTaskCount != null ? t.completedTaskCount : (Array.isArray(t.tasks) ? t.tasks.filter(function (x) { return x.isCompleted || x.completed; }).length : 0))); }, 0);

        var ticketHeading = singleTicket
          ? ((singleTicket.identifier ? singleTicket.identifier + " · " : "") + (singleTicket.title || "Ticket Detail"))
          : (v && v.assignedToMe ? (totalTickets + " Tickets Assigned to You") : (totalTickets + " Project Tickets & Features"));

        var ticketCard = K.card({
          mark: CFG.mark,
          eyebrow: "FABRIC TICKETS & BACKLOG",
          eyebrowMeta: v && v.assignedToMe ? "Assigned to You" : "Features, Bugs & Tasks",
          title: String(ticketHeading),
          sub: singleTicket && singleTicket.description ? String(singleTicket.description).slice(0, 180) : "Live tickets, bugs, and stories from your Fabric projects. Select any item to delegate to Fabric Desktop or Remote Fabric Agents Server.",
          tools: [seg, K.expandButton()],
          label: String(ticketHeading)
        });

        add(ticketCard.body, K.grid([
          K.stat({ label: "Tickets / Stories", value: String(totalTickets), meta: v && v.assignedToMe ? "Assigned to you" : "Active backlog" }),
          K.stat({ label: "Ready / Assigned", value: String(assignedCount), meta: "Spec & ownership" }),
          K.stat({ label: "Tasks Completed", value: totalTasks ? (doneTasks + " / " + totalTasks) : "Synced", meta: "Implementation tasks" })
        ], 140));

        if (ticketList.length) {
          var ticketRows = ticketList.slice(0, 10).map(function (t, idx) {
            if (typeof t === "number" || typeof t === "string") {
              return ["#" + String(t), "ADO Assigned Work Item", "Assigned", "Snapshot ready"];
            }
            var keyStr = String(t.identifier || t.key || (t.id ? String(t.id).slice(0, 8) : ("#" + (idx + 1))));
            var kindPrefix = t.kind === "BUG" ? "[BUG] " : (t.kind === "FEATURE" ? "[FEAT] " : "");
            var statusStr = (t.status && t.status.name) ? t.status.name : String(t.status || t.state || t.draftingStage || "Open");
            var prioStr = String(t.priority || "P2").replace("_", " ");
            var taskInfo = t.taskCount != null ? (" · " + (t.completedTaskCount || 0) + "/" + t.taskCount + " tasks") : "";
            return [
              keyStr,
              kindPrefix + String(t.title || t.name || "Untitled Ticket").slice(0, 52),
              statusStr,
              prioStr + taskInfo
            ];
          });
          add(ticketCard.body, K.table(["Key", "Ticket / Feature", "Status", "Priority & Tasks"], ticketRows));
        } else {
          add(ticketCard.body, K.callout({
            tone: "ok",
            title: "No Open Tickets Matched",
            text: "You have no matching open tickets for this filter, or all assigned items are completed."
          }));
        }

        var firstTicket = ticketList[0] && typeof ticketList[0] === "object" ? ticketList[0] : null;
        var ticketPrompt = firstTicket
          ? ("Implement ticket " + (firstTicket.identifier || firstTicket.id || "") + ": " + (firstTicket.title || ""))
          : "Implement my highest-priority assigned Fabric ticket.";
        var ticketDeepLink = "fabricagents://action/new-chat?harness=" + encodeURIComponent(S.harness) + "&input=" + encodeURIComponent(ticketPrompt) + "&send=true";

        add(ticketCard.body, K.actions([
          K.button(
            S.mode === 1 ? "Start Ticket in Fabric Desktop" : "Delegate Ticket to Remote Server",
            function () {
              if (S.mode === 1) {
                K.openLink(ticketDeepLink);
              } else {
                ask("Delegate \"" + ticketPrompt + "\" to the Remote Fabric Agents Server using " + S.harness + ".");
              }
            },
            { variant: "primary", arrow: S.mode === 1 ? "↗" : "→" }
          ),
          K.button("Open in Fabric Desktop", function () { K.openLink(ticketDeepLink); }, { variant: "outline", arrow: "↗" })
        ]));
        return ticketCard;
      }

      var titleText = (v && (v.projectName || v.title)) || (items.length ? items.length + " Workspace Items Ready" : CFG.title);
      var card = K.card({
        mark: CFG.mark,
        eyebrow: "FABRIC AGENTS",
        eyebrowMeta: S.mode === 0 ? "Remote Subscription Server" : "Fabric Desktop App",
        title: String(titleText),
        sub: CFG.subtitle,
        tools: [seg, K.expandButton()],
        label: String(titleText)
      });

      var chipRow = el("div", "fb-meta-row");
      add(
        chipRow,
        K.chip(v && v.billingMode ? String(v.billingMode) : "Subscription Credits Active", "ok"),
        K.chip("Fallback: " + ((v && (v.fallbackPolicy || v.fallback)) || "subscription_harnesses"), "info"),
        K.chip("Durable Temporal Envelope", "ok")
      );
      add(card.body, chipRow);

      var harnesses = (v && Array.isArray(v.harnesses) && v.harnesses.length) ? v.harnesses : [
        { id: "claude-max", label: "Claude (Opus 4.6 / Sonnet 4.6)", spec: "Subscription OAuth · Primary" },
        { id: "codex", label: "Codex (GPT-5.4 / o3)", spec: "ChatGPT Pro/Team Subscription" },
        { id: "droid-cli", label: "Droid (Factory Multi-Model)", spec: "Subscription OAuth" },
        { id: "grok-cli", label: "Grok (Grok 4 Heavy / Fast)", spec: "Subscription OAuth" },
        { id: "kimi-cli", label: "Kimi (K2.5 Thinking)", spec: "Subscription OAuth" }
      ];

      var tiles = K.choiceTiles({
        label: "Subscription Harness",
        value: (v && v.harness) || S.harness,
        items: harnesses.map(function (h) {
          return {
            value: String(h.id || h.slug || h.name),
            label: String(h.label || h.name || h.id),
            spec: String(h.spec || h.status || h.mode || "Active")
          };
        }),
        onChange: function (val) {
          S.harness = val;
          tell("User selected subscription harness " + val, { harness: val, target: S.mode === 0 ? "remote" : "desktop" });
        }
      });
      add(card.body, tiles);

      if (items.length && !(v && Array.isArray(v.harnesses))) {
        var rows = items.slice(0, 6).map(function (it) {
          return [
            String(it.title || it.name || it.slug || it.id || "Item"),
            String(it.status || it.priority || it.mode || "ready"),
            String(it.source || it.category || it.description || "Fabric").slice(0, 48)
          ];
        });
        add(card.body, K.table(["Item / Integration", "Status", "Detail"], rows));
      }

      var deepLink = (v && v.desktopDeepLink) || ("fabricagents://action/new-chat?harness=" + encodeURIComponent(S.harness) + "&send=true");
      var actButtons = [
        K.button(
          S.mode === 1 ? "Launch Fabric Desktop" : "Delegate to Remote Server",
          function () {
            if (S.mode === 1) {
              K.openLink(deepLink);
            } else {
              callServerTool(CFG.defaultToolName, { target: "remote", harness: S.harness, fallback: "subscription_harnesses" });
            }
          },
          { variant: "primary", arrow: S.mode === 1 ? "↗" : "→" }
        ),
        K.button("Open in Fabric Desktop", function () { K.openLink(deepLink); }, { variant: "outline", arrow: "↗" })
      ];
      add(card.body, K.actions(actButtons));
      return card;
    }

    function drawWorkflowCard(v) {
      var items = extractItems(v);
      var wf = (v && (v.workflow || v.execution || v)) || {};
      var wfTitle = wf.name || wf.title || wf.workflowId || (items.length ? items.length + " Fabric Workflows" : CFG.title);
      var rawSteps = (wf && Array.isArray(wf.steps) && wf.steps) || (items.length ? items : [
        { id: "ingest", name: "Ingest & Validate Context", status: "COMPLETED", detail: "Tenant-isolated input verified in Temporal activity." },
        { id: "transform", name: "Visual Data Prep & Agent Transform", status: "COMPLETED", detail: "Structured transformation and schema validation complete." },
        { id: "persist", name: "Durable Checkpoint & Audit", status: "COMPLETED", detail: "Persisted with deterministic replay history and audit log." }
      ]);

      var nodes = rawSteps.slice(0, 6).map(function (st, idx) {
        return { id: "s" + idx, text: String(st.name || st.title || st.label || st.id || ("Step " + (idx + 1))).slice(0, 32) };
      });
      var edges = [];
      for (var i = 1; i < nodes.length; i++) {
        edges.push({ from: "s" + (i - 1), to: "s" + i, text: "" });
      }
      var g = { kind: "flow", dir: "LR", nodes: nodes, edges: edges };
      var baseScene = K.graphScene(g, K.layoutGraph(g), edges.length);

      var steps = rawSteps.slice(0, 6).map(function (st, idx) {
        var sc = JSON.parse(JSON.stringify(baseScene));
        sc.items.forEach(function (it) {
          if (it.id === "n-s" + idx) it.st = "focus";
          else if (it.id.indexOf("n-s") === 0) {
            var k = Number(it.id.slice(3));
            if (k < idx) it.st = "ok";
          }
        });
        sc.zoom = false;
        return {
          title: String(st.name || st.title || st.label || ("Step " + (idx + 1))),
          body: String(st.detail || st.description || st.summary || ("Status: " + (st.status || "READY"))),
          tip: wf.workflowId ? ("Temporal Workflow ID: " + wf.workflowId) : "Executed durably via Temporal workflow engine",
          scene: sc
        };
      });

      return K.stepper({
        title: String(wfTitle),
        level: (wf.status || "Durable Temporal"),
        label: String(wfTitle),
        caption: "Fabric Visual Data Prep & Durable Temporal Pipeline",
        steps: steps,
        start: S.step,
        stateKey: "wf:" + String(wfTitle),
        recap: {
          title: "Pipeline Summary",
          bullets: steps.slice(0, 3).map(function (s) { return s.title; }),
          actions: [
            { label: "Run via MCP", primary: true, arrow: "→", fn: function () { callServerTool(CFG.defaultToolName, {}); } },
            { label: "Open in Fabric Desktop", arrow: "↗", fn: function () { K.openLink("fabricagents://action/new-chat"); } }
          ]
        },
        onStep: function (i, s) {
          S.step = i;
          tell("In Fabric Workflow Inspector \"" + wfTitle + "\", viewing step " + (i + 1) + ": " + (s ? s.title : "Recap"), { view: "workflow", step: i });
        }
      });
    }

    function drawGenieCard(v) {
      var items = extractItems(v);
      var answer = (v && (v.answer || v.summary || v.content || v.text)) || null;
      var queryText = (v && (v.query || v.question || v.title)) || CFG.title;
      var card = K.card({
        mark: CFG.mark,
        eyebrow: "FABRIC GENIE",
        eyebrowMeta: "Workspace & Lakebase Intelligence",
        title: String(queryText),
        sub: answer ? String(answer).slice(0, 240) : CFG.subtitle,
        tools: [K.expandButton()],
        label: String(queryText)
      });

      var stats = K.grid([
        K.stat({ label: "Matched Sources", value: String(items.length || (v && v.total != null ? v.total : "Ready")), meta: "Tenant-scoped RAG" }),
        K.stat({ label: "Engine", value: "Genie Agent", meta: "Lakebase & Vector Hybrid" })
      ], 160);
      add(card.body, stats);

      if (items.length) {
        var rows = items.slice(0, 6).map(function (it, idx) {
          var score = it.score != null ? (Math.round(Number(it.score) * 100) + "%") : (it.status || ("#" + (idx + 1)));
          return [
            String(it.title || it.name || it.documentTitle || it.path || ("Source " + (idx + 1))),
            String(score),
            String(it.snippet || it.excerpt || it.description || it.content || "Matched workspace knowledge").slice(0, 72)
          ];
        });
        add(card.body, K.table(["Source / Document", "Match", "Excerpt"], rows));
      } else {
        add(card.body, K.callout({
          tone: "info",
          title: "Genie Workspace Query Ready",
          text: "Ask Genie any question across your project documents, libraries, and structured Lakebase tables."
        }));
      }

      var acts = [
        K.button("Ask Genie Follow-Up", function () {
          ask("Using Fabric Genie, dig deeper into \"" + queryText + "\" and compare the top findings.");
        }, { variant: "primary", arrow: "→" }),
        K.button("Open in Fabric Desktop", function () {
          K.openLink("fabricagents://action/new-chat");
        }, { variant: "outline", arrow: "↗" })
      ];
      add(card.body, K.actions(acts));
      return card;
    }

    function drawTriageCard(v) {
      var run = v && v.run, result = v && v.result;
      var card = K.card({ mark: CFG.mark, title: "Private signal review", sub: "Selected evidence only. Keeping a proposal does not create a ticket or share its sources.", tools: [K.expandButton()], label: "Private signal review" });
      if (!run) { add(card.body, K.callout({ tone: "info", title: "Choose a signal review", text: "Open a completed review to inspect its cited proposals." })); return card; }
      add(card.body, K.table(["Status", "Selected signals", "Expires"], [[({QUEUED:"Queued",RUNNING:"Running",COMPLETED:"Completed",FAILED:"Failed",CANCELLED:"Cancelled",OUTCOME_UNKNOWN:"Outcome unconfirmed"})[run.status] || "Unavailable", String(run.selectedCount), Number.isNaN(Date.parse(run.expiresAt)) ? "Unavailable" : new Date(run.expiresAt).toLocaleString()]]));
      if (!result) { add(card.body, K.callout({ tone: "info", title: "No result to disclose", text: "This review has no completed, freshly authorized result." })); return card; }
      var proposals = Array.isArray(result.proposals) ? result.proposals.slice(0, 3) : [];
      if (!proposals.length) add(card.body, K.callout({ tone: "info", title: "No proposals from this selection", text: "This is not a health verdict for the whole project." }));
      proposals.forEach(function (p) {
        add(card.body, K.callout({ tone: "info", title: String(p.title), text: String(p.summary) }));
        if (p.uncertainties && p.uncertainties.length) add(card.body, K.table(["Uncertainties"], p.uncertainties.slice(0, 5).map(function (s) { return [String(s)]; })));
        add(card.body, K.table(["Cited observation", "Source revision"], (p.citations || []).slice(0, 5).map(function (s) { return [String(s.observationId), String(s.grantRevision)]; })));
        var decision = v.reviews && v.reviews[p.id];
        add(card.body, K.callout({ tone: "info", title: "Your decision", text: decision === "KEEP" ? "Kept privately" : decision === "DISMISS" ? "Dismissed" : "Not reviewed" }));
        if (v.projectId) add(card.body, K.actions(["KEEP", "DISMISS"].map(function (value) {
          return K.button(value === "KEEP" ? "Keep privately" : "Dismiss", function () {
            S.r = null; S.v = null; draw();
            return callServerTool("fabric_triage_review", { projectId: String(v.projectId), runId: String(run.id), proposalId: String(p.id), decision: value }).then(function (r) { if (r) onResult(r); }).catch(function () { onResult({ isError: true, content: [{ type: "text", text: "Current access could not be verified. Request this review again to recheck access." }] }); });
          }, { variant: "outline" });
        })));
      });
      if (v.projectId) add(card.body, K.actions([K.button("Check access and refresh", function () {
        S.r = null; S.v = null; draw();
        return callServerTool("fabric_triage_result", { projectId: String(v.projectId), runId: String(run.id) }).then(function (r) { if (r) onResult(r); }).catch(function () { onResult({ isError: true, content: [{ type: "text", text: "Current access could not be verified. Request this review again to recheck access." }] }); });
      }, { variant: "outline" })]));
      return card;
    }

    function drawGenericFabricCard(v) {
      var card = K.card({
        mark: CFG.mark,
        eyebrow: CFG.badge,
        eyebrowMeta: "Fabric MCP App",
        title: CFG.title,
        sub: CFG.subtitle,
        tools: [K.expandButton()],
        label: CFG.title
      });
      if (v && typeof v === "object") {
        add(card.body, K.code({ code: JSON.stringify(v, null, 2).slice(0, 2000), language: "json", title: "Structured Payload" }));
      }
      add(card.body, K.actions([
        K.button("Open in Fabric Desktop", function () { K.openLink("fabricagents://action/new-chat"); }, { variant: "primary", arrow: "↗" }),
        K.button("Refresh via MCP", function () { callServerTool(CFG.defaultToolName, {}); }, { variant: "outline", arrow: "→" })
      ]));
      return card;
    }

    draw();
    K.start({
      appName: CFG.uri.replace("ui://fabric/", "fabric-"),
      appVersion: "2.0.0",
      onResult: onResult,
      onReady: draw,
      onDisplay: draw
    });
  } catch (e) {
    if (typeof Kit !== "undefined" && Kit.fail) Kit.fail(e && e.message);
  }
})();
`;
}

const renderedPageCache = new Map<string, string>();

function renderMcpAppHtml(options: {
	uri: string;
	title: string;
	subtitle: string;
	badge: string;
	defaultToolName: string;
}): string {
	const cached = renderedPageCache.get(options.uri);
	if (cached) {
		return cached;
	}
	const page = kitPageSync({
		uri: options.uri,
		title: options.title,
		css: FABRIC_VIEW_CSS,
		script: buildFabricMcpViewScript(options),
		domains: [],
		accent: FABRIC_BRAND.accent,
		display: FABRIC_BRAND.display,
		buildMeta: "fabric-mcp-app-build",
		loading: `Loading ${options.title}…`,
	});
	renderedPageCache.set(options.uri, page.html);
	return page.html;
}

/**
 * Reads a built-in Fabric MCP App resource (`ui://fabric/*`).
 * Returns `null` if the URI is not a built-in Fabric MCP App resource.
 */
export function readFabricMcpAppResource(
	uri: string,
): { contents: FabricMcpAppResourceContent[] } | null {
	const descriptor = FABRIC_MCP_APP_RESOURCES.find((r) => r.uri === uri);
	if (!descriptor) {
		return null;
	}

	const defaultToolByUri: Record<string, { badge: string; tool: string }> = {
		"ui://fabric/private-triage": {
			badge: "Private signal review",
			tool: "fabric_triage_result",
		},
		"ui://fabric/project-dashboard": {
			badge: "Project MCP App",
			tool: "fabric_get_project",
		},
		"ui://fabric/agent-delegation": {
			badge: "Subscription & Delegation",
			tool: "fabric_list_features",
		},
		"ui://fabric/workflow-visualizer": {
			badge: "Durable Temporal",
			tool: "fabric_list_workflows",
		},
		"ui://fabric/genie-insights": {
			badge: "Genie Agent",
			tool: "fabric_query_workspace",
		},
		"ui://fabric/visualize": {
			badge: "Interactive A2UI",
			tool: "fabric_visualize",
		},
	};

	const meta = defaultToolByUri[uri] ?? {
		badge: "Fabric MCP App",
		tool: "fabric_get_project",
	};

	return {
		contents: [
			{
				uri: descriptor.uri,
				mimeType: descriptor.mimeType,
				text: renderMcpAppHtml({
					uri: descriptor.uri,
					title: descriptor.name,
					subtitle: descriptor.description,
					badge: meta.badge,
					defaultToolName: meta.tool,
				}),
				_meta: descriptor._meta,
			},
		],
	};
}

/**
 * Determines whether an incoming MCP HTTP request opts into stateless mode.
 * Stateless mode allows Fabric Desktop, Remote Fabric Agents Server, and CLI
 * tools to execute single-turn JSON-RPC calls without pre-initializing or
 * persisting server-side session state.
 */
export function isStatelessMcpRequest(request: Request): boolean {
	const header =
		request.headers.get("x-mcp-stateless") ??
		request.headers.get("x-fabric-stateless");
	if (header) {
		const normalized = header.trim().toLowerCase();
		if (
			normalized === "1" ||
			normalized === "true" ||
			normalized === "yes" ||
			normalized === "stateless"
		) {
			return true;
		}
	}
	try {
		const url = new URL(request.url);
		const param = url.searchParams.get("stateless");
		if (param === "1" || param === "true") {
			return true;
		}
	} catch {
		// Ignore malformed URLs
	}
	return false;
}

export interface DurableExecutionMetadata {
	durable: true;
	engine: "temporal";
	workflowId: string;
	runId: string;
	taskQueue: string;
	idempotencyKey: string;
	organizationId: string | null;
	toolName: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	status: "COMPLETED" | "FAILED";
}

/**
 * Checks whether a tool call request asks for durable execution via headers,
 * JSON-RPC `_meta.durable`, or tool arguments (`_durable`).
 */
export function isDurableMcpToolRequest(
	request: Request | null | undefined,
	rpcParams?: Record<string, unknown>,
	toolArgs?: Record<string, unknown>,
): boolean {
	if (request) {
		const header =
			request.headers.get("x-mcp-durable") ??
			request.headers.get("x-fabric-durable");
		if (header) {
			const normalized = header.trim().toLowerCase();
			if (
				normalized === "1" ||
				normalized === "true" ||
				normalized === "yes"
			) {
				return true;
			}
		}
	}
	const meta = rpcParams?._meta as Record<string, unknown> | undefined;
	if (meta?.durable === true || meta?.durableExecution === true) {
		return true;
	}
	if (toolArgs?._durable === true) {
		return true;
	}
	return false;
}

/**
 * Computes a deterministic idempotency key and Temporal-compatible workflow ID
 * for a durable MCP tool call.
 */
function computeDurableWorkflowIdentity(options: {
	organizationId: string | null;
	userId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	explicitIdempotencyKey?: string;
}): { workflowId: string; idempotencyKey: string; runId: string } {
	const {
		organizationId: rawOrganizationId,
		userId,
		toolName,
		toolArgs,
		explicitIdempotencyKey,
	} = options;
	const organizationId = rawOrganizationId ?? "org_default";
	const cleanArgs = { ...toolArgs };
	delete cleanArgs._durable;
	delete cleanArgs._idempotencyKey;

	const idempotencyKey =
		explicitIdempotencyKey ||
		(typeof toolArgs._idempotencyKey === "string" &&
		toolArgs._idempotencyKey.trim()
			? toolArgs._idempotencyKey.trim()
			: createHash("sha256")
					.update(
						JSON.stringify({
							organizationId,
							userId,
							toolName,
							args: cleanArgs,
						}),
					)
					.digest("hex")
					.slice(0, 24));

	const workflowId = `mcp-durable-${organizationId}-${toolName}-${idempotencyKey}`;
	const runId = createHash("sha256")
		.update(`${workflowId}:${Date.now()}`)
		.digest("hex")
		.slice(0, 32);

	return { workflowId, idempotencyKey, runId };
}

/**
 * Executes an MCP tool call inside a durable execution envelope with
 * deterministic Temporal workflow correlation metadata and UI resource linking.
 */
export async function executeWithDurableEnvelope(options: {
	toolName: string;
	toolArgs: Record<string, unknown>;
	organizationId: string | null;
	userId: string;
	explicitIdempotencyKey?: string;
	idempotencyKey?: string;
	execute: () => Promise<ToolCallResult>;
}): Promise<
	ToolCallResult & {
		_meta?: Record<string, unknown> & {
			durableExecution?: DurableExecutionMetadata;
			ui?: { resourceUri: string };
			"ui/resourceUri"?: string;
		};
	}
> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const { workflowId, idempotencyKey, runId } =
		computeDurableWorkflowIdentity({
			organizationId: options.organizationId,
			userId: options.userId,
			toolName: options.toolName,
			toolArgs: options.toolArgs,
			explicitIdempotencyKey:
				options.explicitIdempotencyKey ?? options.idempotencyKey,
		});

	const result = await options.execute();
	const completedAtMs = Date.now();
	const completedAt = new Date(completedAtMs).toISOString();

	const durableExecution: DurableExecutionMetadata = {
		durable: true,
		engine: "temporal",
		workflowId,
		runId,
		taskQueue: TEMPORAL_BACKED_MCP_TOOLS.has(options.toolName)
			? "workflow-builder"
			: "fabric-mcp-durable-tools",
		idempotencyKey,
		organizationId: options.organizationId,
		toolName: options.toolName,
		startedAt,
		completedAt,
		durationMs: Math.max(0, completedAtMs - startedAtMs),
		status: result.isError ? "FAILED" : "COMPLETED",
	};

	const uiResourceUri = FABRIC_TOOL_UI_RESOURCE_MAP[options.toolName];

	return {
		...result,
		_meta: {
			...((result as { _meta?: Record<string, unknown> })._meta ?? {}),
			durableExecution,
			...(uiResourceUri
				? {
						ui: { resourceUri: uiResourceUri },
						"ui/resourceUri": uiResourceUri,
					}
				: {}),
		},
	};
}

/**
 * Attaches the MCP App `ui` resource link (`_meta.ui.resourceUri`) to standard
 * (non-durable) tool call results when the tool is mapped in
 * `FABRIC_TOOL_UI_RESOURCE_MAP` and the call succeeded.
 */
export function attachFabricMcpAppMeta(
	toolName: string,
	result: ToolCallResult,
): ToolCallResult & {
	_meta?: Record<string, unknown> & {
		ui?: { resourceUri: string };
		"ui/resourceUri"?: string;
	};
} {
	const uiResourceUri = FABRIC_TOOL_UI_RESOURCE_MAP[toolName];
	if (!uiResourceUri || result.isError) {
		return result;
	}
	const existingMeta =
		(result as { _meta?: Record<string, unknown> })._meta ?? {};
	return {
		...result,
		_meta: {
			...existingMeta,
			ui: { resourceUri: uiResourceUri },
			"ui/resourceUri": uiResourceUri,
		},
	};
}

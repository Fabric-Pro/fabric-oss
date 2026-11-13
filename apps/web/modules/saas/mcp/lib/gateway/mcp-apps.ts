import { createHash } from "node:crypto";
import type { GatewaySession, ToolCallResult } from "./types";
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
			name: "Fabric Visual Data Prep & Durable Workflow Inspector",
			description:
				"Interactive Fabric-branded DAG pipeline stepper and workflow execution monitor with step-by-step stage diagrams and durable call metadata.",
			mimeType: "text/html;profile=mcp-app",
			_meta: createResourceMeta(
				"Step through Fabric Visual Data Prep pipelines and workflow executions interactively.",
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

	// Workflows and durable execution -> Workflow Visualizer Card
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

const FABRIC_VIEW_CSS = `
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

    // The kit's openLink opens only web links, so "Open in Fabric Desktop" (a fabricagents:// link) did nothing in any
    // host. A desktop link goes to the host as ui/open-link (the host decides what it opens), else a plain link.
    function openDesktop(url) {
      var href = String(url || "");
      if (!/^fabricagents:\/\//.test(href)) { K.openLink(href); return; }
      var fallback = function () {
        try { var a = document.createElement("a"); a.setAttribute("data-k-direct", ""); a.href = href; a.style.display = "none"; document.body.appendChild(a); a.click(); a.remove(); } catch (x) {}
      };
      if (K.can("openLinks")) K.request("ui/open-link", { url: href }).then(function (r) { if (r && r.isError) fallback(); }).catch(fallback);
      else fallback();
    }

    // A button's tool call shows what came back, or why it failed, in this card (before, the result was dropped and
    // a failed call looked like a button that did nothing).
    function runTool(name, args) {
      return callServerTool(name, args).then(function (r) { if (r) onResult(r); return r; }, function (e) {
        onResult({ isError: true, content: [{ type: "text", text: (e && e.message) ? String(e.message) : "That request couldn't complete." }] });
        return null;
      });
    }

    // The work a delegation card hands on: the result's own prompt, else what the card shows.
    function delegationTask(v, items) {
      var first = items && items[0] && typeof items[0] === "object" ? items[0] : null;
      var named = first && (first.identifier || first.key) ? String(first.identifier || first.key) + ": " : "";
      if (v && typeof v.prompt === "string" && v.prompt.trim()) return v.prompt.trim();
      if (first && (first.title || first.name)) return "Work on " + named + String(first.title || first.name);
      if (v && (v.projectName || v.title)) return "Work on " + String(v.projectName || v.title);
      return "Continue this Fabric work";
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

      if (CFG.uri === "ui://fabric/project-dashboard") {
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
          K.button("Open in Fabric Desktop", function () { openDesktop("fabricagents://action/new-chat"); }, { variant: firstUrl ? "outline" : "primary", arrow: "↗" }),
          K.button("List All Artifacts", function () { runTool("fabric_list_frames", {}); }, { variant: "quiet", arrow: "→" })
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
        K.button("Open in Fabric Desktop", function () { openDesktop(deepLink); }, { variant: "primary", arrow: "↗" }),
        K.button("My Assigned Tickets", function () {
          if (projId) {
            runTool("fabric_list_features", { projectId: String(projId), assignedToMe: true });
          } else {
            ask("Show me the tickets, features, and bugs assigned to me across my Fabric projects.");
          }
        }, { variant: "outline", arrow: "→" }),
        K.button("View Artifacts", function () {
          runTool("fabric_list_frames", projId ? { surface: "artifact", projectId: String(projId) } : {});
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
                openDesktop(ticketDeepLink);
              } else {
                ask("Delegate \"" + ticketPrompt + "\" to the Remote Fabric Agents Server using " + S.harness + ".");
              }
            },
            { variant: "primary", arrow: S.mode === 1 ? "↗" : "→" }
          ),
          K.button("Open in Fabric Desktop", function () { openDesktop(ticketDeepLink); }, { variant: "outline", arrow: "↗" })
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
      if (v && v.billingMode) add(chipRow, K.chip(String(v.billingMode), "ok"));
      add(chipRow, K.chip("Fallback: " + ((v && (v.fallbackPolicy || v.fallback)) || "subscription_harnesses"), "info"));
      var durableMeta = S.r && S.r._meta && S.r._meta.durableExecution;
      if (durableMeta && durableMeta.stored === true) {
        add(chipRow, K.chip(durableMeta.replayed ? "Stored Call · Replayed" : "Stored Durable Call", "ok"));
      }
      add(card.body, chipRow);

      var harnesses = (v && Array.isArray(v.harnesses)) ? v.harnesses : [];
      if (harnesses.length) {
        var tiles = K.choiceTiles({
          label: "Subscription Harness",
          value: (v && v.harness) || S.harness,
          items: harnesses.map(function (h) {
            return {
              value: String(h.id || h.slug || h.name),
              label: String(h.label || h.name || h.id),
              spec: String(h.spec || h.status || h.mode || "Status not checked")
            };
          }),
          onChange: function (val) {
            S.harness = val;
            tell("User selected subscription harness " + val, { harness: val, target: S.mode === 0 ? "remote" : "desktop" });
          }
        });
        add(card.body, tiles);
      }

      if (items.length && !(v && Array.isArray(v.harnesses))) {
        var rows = items.slice(0, 6).map(function (it) {
          return [
            String(it.title || it.name || it.slug || it.id || "Item"),
            String(it.status || it.priority || it.mode || "Status unavailable"),
            String(it.source || it.category || it.description || "Fabric").slice(0, 48)
          ];
        });
        add(card.body, K.table(["Item / Integration", "Status", "Detail"], rows));
      }

      var task = delegationTask(v, items);
      var deepLink = (v && v.desktopDeepLink) || ("fabricagents://action/new-chat?harness=" + encodeURIComponent(S.harness) + "&input=" + encodeURIComponent(task));
      var actButtons = [
        K.button(
          S.mode === 1 ? "Launch Fabric Desktop" : "Delegate to Remote Server",
          function () {
            if (S.mode === 1) {
              openDesktop(deepLink);
            } else {
              // No server dispatches to a Remote Fabric Agents Server (the local fabric_delegate_agent only builds links,
              // and the hosted gateway has no such tool), so the person's assistant does it, as for a ticket.
              ask("Delegate \"" + task + "\" to the Remote Fabric Agents Server using " + S.harness + ".");
            }
          },
          { variant: "primary", arrow: S.mode === 1 ? "↗" : "→" }
        ),
        K.button("Open in Fabric Desktop", function () { openDesktop(deepLink); }, { variant: "outline", arrow: "↗" })
      ];
      add(card.body, K.actions(actButtons));
      return card;
    }

    function drawWorkflowCard(v) {
      var items = extractItems(v);
      var wf = (v && (v.workflow || v.execution || v)) || {};
      var durableExecution = S.r && S.r._meta && S.r._meta.durableExecution;
      var wfTitle = wf.name || wf.title || (items.length ? items.length + " Fabric Workflows" : CFG.title);
      var rawSteps = (wf && Array.isArray(wf.steps) && wf.steps) || (items.length ? items : []);
      if (!rawSteps.length) {
        var emptyCard = K.card({ mark: CFG.mark, eyebrow: "FABRIC WORKFLOWS", eyebrowMeta: "No execution data", title: String(wfTitle), sub: CFG.subtitle, tools: [K.expandButton()], label: String(wfTitle) });
        add(emptyCard.body, K.callout({ tone: "info", title: "No workflow steps returned", text: "Run or inspect a workflow to view its reported steps." }));
        return emptyCard;
      }

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
          body: String(st.detail || st.description || st.summary || (st.status ? ("Status: " + st.status) : "No detail reported")),
          tip: durableExecution && durableExecution.executionId ? ("Durable execution ID: " + durableExecution.executionId) : "Reported by the tool result",
          scene: sc
        };
      });

      return K.stepper({
        title: String(wfTitle),
        level: (wf.status || "Workflow"),
        label: String(wfTitle),
        caption: "Fabric Visual Data Prep & Workflow Pipeline",
        steps: steps,
        start: S.step,
        stateKey: "wf:" + String(wfTitle),
        recap: {
          title: "Pipeline Summary",
          bullets: steps.slice(0, 3).map(function (s) { return s.title; }),
          actions: [
            { label: "Run via MCP", primary: true, arrow: "→", fn: function () { runTool(CFG.defaultToolName, {}); } },
            { label: "Open in Fabric Desktop", arrow: "↗", fn: function () { openDesktop("fabricagents://action/new-chat"); } }
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
          openDesktop("fabricagents://action/new-chat");
        }, { variant: "outline", arrow: "↗" })
      ];
      add(card.body, K.actions(acts));
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
        K.button("Open in Fabric Desktop", function () { openDesktop("fabricagents://action/new-chat"); }, { variant: "primary", arrow: "↗" }),
        K.button("Refresh via MCP", function () { runTool(CFG.defaultToolName, {}); }, { variant: "outline", arrow: "→" })
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
		"ui://fabric/project-dashboard": {
			badge: "Project MCP App",
			tool: "fabric_get_project",
		},
		"ui://fabric/agent-delegation": {
			badge: "Subscription & Delegation",
			tool: "fabric_list_features",
		},
		"ui://fabric/workflow-visualizer": {
			badge: "Durable Workflow",
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
	engine: "fabric-idempotency-store" | "inline";
	executionId: string | null;
	idempotencyKey: string | null;
	status: "RUNNING" | "COMPLETED" | "FAILED";
	replayed: boolean;
	deduplicated: boolean;
	stored: boolean;
	startedAt: string;
	completedAt: string | null;
	resultWithheld?: boolean;
	reason?: "no_idempotency_key" | "storage_failed" | "authorization_refused";
	retryable?: boolean;
}

interface DurableToolCallRecord {
	id: string;
	argsHash: string;
	status: "RUNNING" | "COMPLETED" | "FAILED";
	result: unknown | null;
	createdAt?: Date;
	startedAt?: Date;
	updatedAt?: Date;
	completedAt: Date | null;
}

export interface DurableToolCallStore {
	claim(input: {
		organizationId: string;
		userId: string;
		credentialKind: string;
		credentialId: string;
		projectBinding: string | null;
		serverBinding: string;
		toolName: string;
		idempotencyKey: string;
		argsHash: string;
	}): Promise<{
		kind: "claimed" | "replay" | "conflict" | "in_progress";
		call: DurableToolCallRecord;
	}>;
	complete(input: {
		executionId: string;
		claimUpdatedAt?: Date;
		result: Record<string, unknown>;
		status: "COMPLETED" | "FAILED";
	}): Promise<void>;
}

export interface DurableToolCallIdentity {
	credentialKind: string;
	credentialId: string;
	projectBinding: string | null;
	serverBinding: string;
}

/**
 * Build the replay boundary from the authenticated gateway session. A legacy
 * in-memory session without a persisted credential id is isolated to its own
 * session id instead of being allowed to share receipts with another key.
 */
export function durableIdentityForGatewaySession(
	session: GatewaySession,
	serverBinding: string,
): DurableToolCallIdentity {
	return {
		credentialKind: session.credential,
		credentialId:
			session.credentialId ??
			session.oauthClientId ??
			`gateway-session:${session.sessionId}`,
		projectBinding:
			session.projectId ??
			session.pinnedProjectId ??
			session.pageProjectId ??
			null,
		serverBinding,
	};
}

export type DurableToolAuthorization<Context> =
	| { ok: true; context: Context }
	| { ok: false; result: ToolCallResult };

const databaseDurableToolCallStore: DurableToolCallStore = {
	async claim(input) {
		const { claimMcpDurableToolCall } = await import("@repo/database");
		return claimMcpDurableToolCall(input);
	},
	async complete(input) {
		if (!input.claimUpdatedAt) {
			throw new Error(
				"MCP durable claim is missing its completion fence",
			);
		}
		const { completeMcpDurableToolCall } = await import("@repo/database");
		await completeMcpDurableToolCall({
			...input,
			claimUpdatedAt: input.claimUpdatedAt,
			result: input.result as never,
		});
	},
};

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

function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalizeJson);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalizeJson(child)]),
		);
	}
	return value;
}

function durableArgsHash(toolArgs: Record<string, unknown>): string {
	const cleanArgs = { ...toolArgs };
	delete cleanArgs._durable;
	delete cleanArgs._idempotencyKey;
	return createHash("sha256")
		.update(JSON.stringify(canonicalizeJson(cleanArgs)))
		.digest("hex");
}

function resolveDurableIdempotencyKey(options: {
	request?: Request | null;
	rpcParams?: Record<string, unknown>;
	toolArgs: Record<string, unknown>;
	explicitIdempotencyKey?: string;
	idempotencyKey?: string;
}): string | null {
	const meta = options.rpcParams?._meta as
		| Record<string, unknown>
		| undefined;
	const candidates = [
		options.request?.headers.get("x-mcp-idempotency-key"),
		meta?.idempotencyKey,
		options.explicitIdempotencyKey ?? options.idempotencyKey,
		options.toolArgs._idempotencyKey,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return null;
}

function durableToolError(
	message: string,
	durableExecution: DurableExecutionMetadata,
): ToolCallResult & { _meta: { durableExecution: DurableExecutionMetadata } } {
	return {
		isError: true,
		content: [{ type: "text", text: message }],
		_meta: { durableExecution },
	};
}

function recordStartedAt(
	call: DurableToolCallRecord,
	claimKind: "claimed" | "replay" | "conflict" | "in_progress",
): string {
	return (
		(claimKind === "claimed" ? call.updatedAt : call.createdAt) ??
		call.startedAt ??
		call.createdAt ??
		call.updatedAt ??
		new Date()
	).toISOString();
}

function jsonRecord(value: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Claims and completes a tenant- and user-bound durable execution receipt around
 * an MCP tool call. Calls without an explicit key still execute, but are not
 * represented as deduplicated or stored.
 */
export async function executeWithDurableEnvelope<Context>(options: {
	toolName: string;
	toolArgs: Record<string, unknown>;
	organizationId: string | null;
	userId: string;
	identity:
		| DurableToolCallIdentity
		| ((context: Context) => DurableToolCallIdentity);
	request?: Request | null;
	rpcParams?: Record<string, unknown>;
	explicitIdempotencyKey?: string;
	idempotencyKey?: string;
	authorize: () => Promise<DurableToolAuthorization<Context>>;
	execute: (context: Context) => Promise<ToolCallResult>;
	replayAllowed?: boolean | ((context: Context) => boolean);
	store?: DurableToolCallStore;
}): Promise<
	ToolCallResult & {
		_meta?: Record<string, unknown> & {
			durableExecution?: DurableExecutionMetadata;
			ui?: { resourceUri: string };
			"ui/resourceUri"?: string;
		};
	}
> {
	const uiResourceUri = FABRIC_TOOL_UI_RESOURCE_MAP[options.toolName];
	const withMetadata = (
		result: ToolCallResult,
		durableExecution: DurableExecutionMetadata,
	) => ({
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
	});
	const requestedAt = new Date();
	const idempotencyKey = resolveDurableIdempotencyKey(options);

	if (!options.organizationId) {
		return durableToolError("Durable execution requires an organization.", {
			durable: true,
			engine: "fabric-idempotency-store",
			executionId: null,
			idempotencyKey,
			status: "FAILED",
			replayed: false,
			deduplicated: false,
			stored: false,
			startedAt: requestedAt.toISOString(),
			completedAt: new Date().toISOString(),
		});
	}

	const authorization = await options.authorize();
	if (!authorization.ok) {
		return withMetadata(authorization.result, {
			durable: true,
			engine: "inline",
			executionId: null,
			idempotencyKey,
			status: "FAILED",
			replayed: false,
			deduplicated: false,
			stored: false,
			reason: "authorization_refused",
			startedAt: requestedAt.toISOString(),
			completedAt: new Date().toISOString(),
		});
	}

	const replayAllowed =
		typeof options.replayAllowed === "function"
			? options.replayAllowed(authorization.context)
			: options.replayAllowed !== false;
	if (!idempotencyKey) {
		const result = await options.execute(authorization.context);
		return withMetadata(result, {
			durable: true,
			engine: "inline",
			executionId: null,
			idempotencyKey: null,
			status: result.isError ? "FAILED" : "COMPLETED",
			replayed: false,
			deduplicated: false,
			stored: false,
			reason: "no_idempotency_key",
			startedAt: requestedAt.toISOString(),
			completedAt: new Date().toISOString(),
		});
	}

	const store = options.store ?? databaseDurableToolCallStore;
	const identity =
		typeof options.identity === "function"
			? options.identity(authorization.context)
			: options.identity;
	let claim: Awaited<ReturnType<DurableToolCallStore["claim"]>>;
	try {
		claim = await store.claim({
			organizationId: options.organizationId,
			userId: options.userId,
			credentialKind: identity.credentialKind,
			credentialId: identity.credentialId,
			projectBinding: identity.projectBinding,
			serverBinding: identity.serverBinding,
			toolName: options.toolName,
			idempotencyKey,
			argsHash: durableArgsHash(options.toolArgs),
		});
	} catch (error) {
		console.error("[MCP Durable] Failed to claim tool call:", {
			toolName: options.toolName,
			error: error instanceof Error ? error.message : error,
		});
		return durableToolError(
			"Durable execution is temporarily unavailable.",
			{
				durable: true,
				engine: "fabric-idempotency-store",
				executionId: null,
				idempotencyKey,
				status: "FAILED",
				replayed: false,
				deduplicated: true,
				stored: false,
				reason: "storage_failed",
				startedAt: requestedAt.toISOString(),
				completedAt: new Date().toISOString(),
			},
		);
	}

	const baseMetadata = {
		durable: true as const,
		engine: "fabric-idempotency-store" as const,
		executionId: claim.call.id,
		idempotencyKey,
		deduplicated: true,
		stored: true,
		startedAt: recordStartedAt(claim.call, claim.kind),
	};
	if (claim.kind === "conflict") {
		return durableToolError(
			"This idempotency key was already used with different arguments.",
			{
				...baseMetadata,
				status: "FAILED",
				replayed: false,
				completedAt: new Date().toISOString(),
			},
		);
	}
	if (claim.kind === "in_progress") {
		return durableToolError(
			"A tool call with this idempotency key is already in progress. Retry later.",
			{
				...baseMetadata,
				status: "RUNNING",
				replayed: false,
				retryable: true,
				completedAt: null,
			},
		);
	}
	if (claim.kind === "replay") {
		const completedAt =
			claim.call.completedAt ??
			claim.call.updatedAt ??
			claim.call.createdAt ??
			new Date();
		if (!replayAllowed) {
			return withMetadata(
				{
					content: [
						{
							type: "text",
							text: `Durable call ${claim.call.id} with this idempotency key already completed at ${completedAt.toISOString()}. Status: COMPLETED. The stored result is not replayed for ${options.toolName}. Use a matching get/list tool to read the current state.`,
						},
					],
				},
				{
					...baseMetadata,
					status: "COMPLETED",
					replayed: false,
					resultWithheld: true,
					completedAt: completedAt.toISOString(),
				},
			);
		}
		const replayed = (claim.call.result ?? {
			isError: true,
			content: [
				{ type: "text", text: "Stored durable result is unavailable." },
			],
		}) as unknown as ToolCallResult;
		return withMetadata(replayed, {
			...baseMetadata,
			status: "COMPLETED",
			replayed: true,
			completedAt: completedAt.toISOString(),
		});
	}

	let result: ToolCallResult;
	try {
		result = await options.execute(authorization.context);
	} catch (error) {
		try {
			await store.complete({
				executionId: claim.call.id,
				claimUpdatedAt: claim.call.updatedAt,
				result: {
					isError: true,
					content: [
						{
							type: "text",
							text: "Tool execution failed before returning a result.",
						},
					],
				},
				status: "FAILED",
			});
		} catch (completionError) {
			console.error("[MCP Durable] Failed to release thrown tool call:", {
				executionId: claim.call.id,
				toolName: options.toolName,
				error:
					completionError instanceof Error
						? completionError.message
						: completionError,
			});
		}
		throw error;
	}
	const status = result.isError ? "FAILED" : "COMPLETED";
	const completedAt = new Date();
	let stored = true;
	try {
		await store.complete({
			executionId: claim.call.id,
			claimUpdatedAt: claim.call.updatedAt,
			result: jsonRecord(result),
			status,
		});
	} catch (error) {
		stored = false;
		console.error("[MCP Durable] Failed to persist completed tool call:", {
			executionId: claim.call.id,
			toolName: options.toolName,
			error: error instanceof Error ? error.message : error,
		});
	}
	return withMetadata(result, {
		...baseMetadata,
		status,
		replayed: false,
		stored,
		...(stored ? {} : { reason: "storage_failed" as const }),
		completedAt: completedAt.toISOString(),
	});
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

import { createHash } from "node:crypto";
import type { ToolCallResult } from "./types";
import {
	buildFabricVisualizePayload,
	FABRIC_BRAND,
	FABRIC_MARK_DATA_URI,
	type FabricVisualizeResult,
	kitPageSync,
} from "./ui-kit";

export {
	buildFabricVisualizePayload,
	FABRIC_BRAND,
	FABRIC_MARK_DATA_URI,
	type FabricVisualizeResult,
};

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
	// Project & Frame tools -> Project Dashboard Card
	fabric_list_projects: "ui://fabric/project-dashboard",
	fabric_get_project: "ui://fabric/project-dashboard",
	fabric_create_project: "ui://fabric/project-dashboard",
	fabric_update_project: "ui://fabric/project-dashboard",
	fabric_list_frames: "ui://fabric/project-dashboard",
	fabric_get_frame: "ui://fabric/project-dashboard",

	// Features, Agent Delegation, Subscriptions & Integrations -> Agent Delegation Card
	fabric_list_features: "ui://fabric/agent-delegation",
	fabric_get_feature: "ui://fabric/agent-delegation",
	fabric_create_feature: "ui://fabric/agent-delegation",
	fabric_update_feature: "ui://fabric/agent-delegation",
	fabric_delegate_agent: "ui://fabric/agent-delegation",
	fabric_subscription_status: "ui://fabric/agent-delegation",
	fabric_list_mcp_servers: "ui://fabric/agent-delegation",
	fabric_list_integrations: "ui://fabric/agent-delegation",
	fabric_list_operations: "ui://fabric/agent-delegation",
	fabric_call: "ui://fabric/agent-delegation",

	// Workflows & Durable Temporal Execution -> Workflow Visualizer Card
	fabric_list_workflows: "ui://fabric/workflow-visualizer",
	fabric_get_workflow: "ui://fabric/workflow-visualizer",
	fabric_execute_workflow: "ui://fabric/workflow-visualizer",
	fabric_get_workflow_execution: "ui://fabric/workflow-visualizer",
	fabric_list_workflow_executions: "ui://fabric/workflow-visualizer",

	// Genie, Workspace Knowledge, Documents & Libraries -> Genie Insights Card
	fabric_query_workspace: "ui://fabric/genie-insights",
	fabric_search_knowledge: "ui://fabric/genie-insights",
	fabric_list_documents: "ui://fabric/genie-insights",
	fabric_get_document: "ui://fabric/genie-insights",
	fabric_list_libraries: "ui://fabric/genie-insights",
	fabric_query_library: "ui://fabric/genie-insights",

	// A2UI Interactive Visualization -> Visualize Card
	fabric_visualize: "ui://fabric/visualize",
	visualize: "ui://fabric/visualize",
};

/**
 * Tools whose underlying execution is backed by Temporal workflows by default.
 */
export const TEMPORAL_BACKED_MCP_TOOLS: ReadonlySet<string> = new Set([
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
      var keys = ["projects", "features", "workflows", "executions", "documents", "results", "chunks", "matches", "integrations", "servers", "frames", "items", "harnesses"];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(v[keys[i]])) return v[keys[i]];
      }
      return [];
    }

    function drawProjectCard(v) {
      var p = (v && (v.project || v)) || {};
      var items = extractItems(v);
      var projName = p.name || p.title || (items.length ? items.length + " Fabric Projects" : CFG.title);
      var projSlug = p.slug || p.id || "fabric-workspace";
      var desc = p.description || p.summary || CFG.subtitle;
      var card = K.card({
        mark: CFG.mark,
        eyebrow: "FABRIC WORKSPACE",
        eyebrowMeta: CFG.badge,
        title: String(projName),
        sub: String(desc),
        tools: [K.expandButton()],
        label: String(projName)
      });

      var stats = K.grid([
        K.stat({ label: "Projects / Items", value: String(items.length || (p.id ? 1 : "Ready")), meta: p.status || "Active tenant" }),
        K.stat({ label: "Features", value: String(p.featureCount != null ? p.featureCount : (p._count && p._count.features != null ? p._count.features : "Synced")), meta: "Backlog & specs" }),
        K.stat({ label: "Living Memory", value: String(p.contextCount != null ? p.contextCount : (p.documentCount != null ? p.documentCount : "Active")), meta: "RAG & instructions" })
      ], 140);
      add(card.body, stats);

      if (items.length) {
        var rows = items.slice(0, 8).map(function (it) {
          return [
            String(it.name || it.title || it.slug || it.id || "Item"),
            String(it.status || it.state || it.kind || "active"),
            String(it.updatedAt ? String(it.updatedAt).slice(0, 10) : (it.description || "—")).slice(0, 60)
          ];
        });
        add(card.body, K.table(["Name", "Status", "Detail"], rows));
      } else {
        add(card.body, K.callout({
          tone: "info",
          title: "Connected to Fabric MCP",
          text: "Ask your assistant to inspect a project, list features, or launch a coding session in Fabric Desktop."
        }));
      }

      var deepLink = "fabricagents://action/new-chat?workspace=" + encodeURIComponent(String(projSlug));
      var actButtons = [
        K.button("Open in Fabric Desktop", function () { K.openLink(deepLink); }, { variant: "primary", arrow: "↗" }),
        K.button("Delegate to Remote Server", function () {
          ask("Delegate the next coding task for project \"" + projName + "\" to the Remote Fabric Agents Server using my subscription harness.");
        }, { variant: "outline", arrow: "→" })
      ];
      if (canAsk()) {
        actButtons.push(K.button("Ask about this", function () {
          ask("Summarize the current priorities and open features for Fabric project \"" + projName + "\".");
        }, { variant: "quiet" }));
      }
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
	organizationId: string;
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
export function computeDurableWorkflowIdentity(options: {
	organizationId: string;
	userId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	explicitIdempotencyKey?: string;
}): { workflowId: string; idempotencyKey: string; runId: string } {
	const {
		organizationId,
		userId,
		toolName,
		toolArgs,
		explicitIdempotencyKey,
	} = options;
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
	organizationId: string;
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

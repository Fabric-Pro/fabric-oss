/**
 * fabric agents
 *
 *   fabric agents list           List agents
 *   fabric agents show <id>      Show agent details
 */

import type { FabricAgent } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

const ALLOWED_DELEGATE_TARGETS = new Set(["desktop", "remote"]);
const ALLOWED_DELEGATE_HARNESSES = new Set([
	"auto",
	"default",
	"claude-max",
	"codex",
	"chatgpt-plus",
	"droid-cli",
	"grok-cli",
	"kimi-cli",
	"antigravity-cli",
	"cursor",
	"cursor-cli",
]);
const ALLOWED_FALLBACK_POLICIES = new Set([
	"subscription_harnesses",
	"org_paid_api",
	"pause_on_limit",
]);
const ALLOWED_DESKTOP_VIEWS = new Set([
	"allSessions",
	"settings",
	"sources",
	"agents",
	"skills",
]);

function normalizeValidatedServerUrl(rawUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		printError(
			`--server-url must be a valid HTTP(S) URL (received "${rawUrl}")`,
			2,
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		printError(
			"--server-url must use https:// (or http:// for localhost/127.0.0.1)",
			2,
		);
	}
	if (
		parsed.protocol === "http:" &&
		parsed.hostname !== "localhost" &&
		parsed.hostname !== "127.0.0.1" &&
		parsed.hostname !== "[::1]"
	) {
		printError(
			"--server-url with http:// is only allowed for localhost or 127.0.0.1; use https:// for remote servers",
			2,
		);
	}
	if (parsed.username || parsed.password) {
		printError("--server-url must not embed credentials", 2);
	}
	return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

export function buildAgentsCommand(): Command {
	const agents = new Command("agents").description("Manage agents");

	// -- list ----------------------------------------------------------------
	agents
		.command("list")
		.description("List agents")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--status <status>", "Filter: ACTIVE|INACTIVE|DEPRECATED")
		.option("--limit <n>", "Max results", "50")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			"table",
		)
		.option("-q, --quiet", "Print IDs only")
		.action(
			async (opts: {
				org?: string;
				personal?: boolean;
				status?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricAgent[];
				try {
					list = await client.agents.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						status: opts.status as
							| FabricAgent["status"]
							| undefined,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const a of list) {
						process.stdout.write(`${a.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"id",
						"name",
						"displayName",
						"framework",
						"status",
						"createdAt",
					],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	agents
		.command("show <id>")
		.description("Show agent details")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: { org?: string; personal?: boolean; format: string },
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let agent: FabricAgent;
				try {
					agent = await client.agents.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(agent, { format: fmt });
					return;
				}

				printRecord({
					ID: agent.id,
					"Agent ID": agent.agentId,
					Name: agent.name,
					"Display name": agent.displayName,
					Framework: agent.framework,
					Status: agent.status,
					"Deployment URL": agent.deploymentUrl ?? "(none)",
					Created: agent.createdAt.slice(0, 10),
				});
			},
		);

	// -- execute -------------------------------------------------------------
	agents
		.command("execute <id>")
		.description("Execute an agent")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--input <json>", 'Input JSON (e.g. \'{"key":"value"}\')')
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: {
					org?: string;
					personal?: boolean;
					input?: string;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();

				let inputObj: Record<string, unknown> = {};
				if (opts.input) {
					try {
						inputObj = JSON.parse(opts.input);
					} catch {
						printError("--input must be valid JSON", 2);
					}
				}

				let result: import("@fabricorg/sdk").FabricAgentExecution;
				try {
					result = await client.agents.execute(id, {
						input: inputObj,
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(result, { format: fmt });
					return;
				}

				printRecord({
					"Task ID": result.taskId,
					"Workflow ID": result.workflowId,
					"Run ID": result.runId ?? "(pending)",
					Status: result.status,
					...(result.warning ? { Warning: result.warning } : {}),
				});
			},
		);

	// -- delegate ------------------------------------------------------------
	agents
		.command("delegate")
		.description(
			"Delegate a coding task to Fabric Desktop (fabricagents://) or Remote Fabric Agents Server using subscription harnesses",
		)
		.option("--org <slug>", "Organization context")
		.option("--project <id>", "Project ID to bind the delegated session to")
		.option("--project-slug <slug>", "Project slug for workspace routing")
		.option(
			"--target <target>",
			"Execution target: desktop|remote",
			"remote",
		)
		.option(
			"--server-url <url>",
			"Remote Fabric Agents Server URL",
			process.env.FABRIC_AGENTS_SERVER_URL ??
				"https://agents.example.com",
		)
		.option(
			"--harness <harness>",
			"Subscription harness: auto|claude-max|codex|droid-cli|grok-cli|kimi-cli|antigravity-cli|cursor",
			"claude-max",
		)
		.option("--model <model>", "Optional model override")
		.option(
			"--fallback <policy>",
			"Quota fallback policy: subscription_harnesses|org_paid_api|pause_on_limit",
			"subscription_harnesses",
		)
		.option("--prompt <text>", "Task prompt to dispatch")
		.option(
			"--durable",
			"Execute inside a durable Temporal workflow envelope",
		)
		.option(
			"--format <format>",
			"Output format: table|json|yaml|plain",
			"table",
		)
		.option("-q, --quiet", "Print delegation URL only")
		.addHelpText(
			"after",
			`
Examples:
  $ fabric agents delegate --target remote --harness claude-max --prompt "Refactor auth middleware"
  $ fabric agents delegate --target desktop --project-slug payments-v2 --prompt "Add unit tests" -q
  $ fabric agents delegate --target remote --harness codex --fallback org_paid_api --format json
`,
		)
		.action(
			async (opts: {
				org?: string;
				project?: string;
				projectSlug?: string;
				target: string;
				serverUrl: string;
				harness: string;
				model?: string;
				fallback: string;
				prompt?: string;
				durable?: boolean;
				format: string;
				quiet?: boolean;
			}) => {
				if (!ALLOWED_DELEGATE_TARGETS.has(opts.target)) {
					printError(
						`--target must be one of: ${[...ALLOWED_DELEGATE_TARGETS].join(", ")}`,
						2,
					);
				}
				if (!ALLOWED_DELEGATE_HARNESSES.has(opts.harness)) {
					printError(
						`--harness must be one of: ${[...ALLOWED_DELEGATE_HARNESSES].join(", ")}`,
						2,
					);
				}
				if (!ALLOWED_FALLBACK_POLICIES.has(opts.fallback)) {
					printError(
						`--fallback must be one of: ${[...ALLOWED_FALLBACK_POLICIES].join(", ")}`,
						2,
					);
				}
				const target = opts.target as "desktop" | "remote";
				const cleanServer = normalizeValidatedServerUrl(opts.serverUrl);
				const query = new URLSearchParams();
				if (opts.projectSlug) {
					query.set("workspace", opts.projectSlug);
					query.set("project", opts.projectSlug);
				}
				if (opts.project) {
					query.set("projectId", opts.project);
				}
				query.set("harness", opts.harness);
				if (opts.model) {
					query.set("model", opts.model);
				}
				query.set("fallback", opts.fallback);
				if (opts.prompt) {
					query.set("input", opts.prompt);
					query.set("prompt", opts.prompt);
					query.set("send", "true");
				}
				if (opts.durable) {
					query.set("durable", "true");
				}

				const desktopDeepLink = `fabricagents://action/new-chat?${query.toString()}`;
				const remoteDelegationUrl = `${cleanServer}/?${query.toString()}`;
				const activeUrl =
					target === "desktop"
						? desktopDeepLink
						: remoteDelegationUrl;

				if (opts.quiet) {
					process.stdout.write(`${activeUrl}\n`);
					return;
				}

				const payload = {
					status: "ready",
					target,
					harness: opts.harness,
					model: opts.model ?? "default",
					fallbackPolicy: opts.fallback,
					billingMode: "subscription_tokens",
					durable: Boolean(opts.durable),
					projectId: opts.project ?? null,
					projectSlug: opts.projectSlug ?? null,
					delegationUrl: activeUrl,
					desktopDeepLink,
					remoteDelegationUrl,
				};

				const fmt = opts.format as "table" | "json" | "yaml" | "plain";
				if (fmt === "json" || fmt === "yaml" || fmt === "plain") {
					printOutput(payload, { format: fmt });
					return;
				}

				printRecord({
					Status: payload.status,
					Target:
						target === "desktop"
							? "Fabric Desktop (fabricagents://)"
							: `Remote Fabric Agents Server (${cleanServer})`,
					Harness: payload.harness,
					Model: payload.model,
					"Fallback Policy": payload.fallbackPolicy,
					"Billing Mode": "Subscription Credits (0 API Key Spend)",
					Durable: payload.durable ? "yes (Temporal)" : "no",
					"Delegation URL": payload.delegationUrl,
				});
			},
		);

	// -- desktop -------------------------------------------------------------
	agents
		.command("desktop")
		.description(
			"Generate a 1-click Fabric Desktop (fabricagents://) deep link for a project or view",
		)
		.option("--project <id>", "Project ID")
		.option("--project-slug <slug>", "Project slug")
		.option(
			"--view <view>",
			"Target view: allSessions|settings|sources|agents|skills",
			"allSessions",
		)
		.option("--prompt <text>", "Pre-filled prompt for a new chat")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|plain",
			"table",
		)
		.option("-q, --quiet", "Print deep link URL only")
		.action(
			async (opts: {
				project?: string;
				projectSlug?: string;
				view: string;
				prompt?: string;
				format: string;
				quiet?: boolean;
			}) => {
				if (!ALLOWED_DESKTOP_VIEWS.has(opts.view)) {
					printError(
						`--view must be one of: ${[...ALLOWED_DESKTOP_VIEWS].join(", ")}`,
						2,
					);
				}
				const query = new URLSearchParams();
				if (opts.projectSlug) {
					query.set("workspace", opts.projectSlug);
				}
				if (opts.project) {
					query.set("projectId", opts.project);
				}
				if (opts.prompt) {
					query.set("input", opts.prompt);
					query.set("send", "true");
				}
				const path = opts.prompt
					? "action/new-chat"
					: opts.view || "allSessions";
				const qs = query.toString();
				const deepLink = `fabricagents://${path}${qs ? `?${qs}` : ""}`;

				if (opts.quiet) {
					process.stdout.write(`${deepLink}\n`);
					return;
				}

				const payload = {
					deepLink,
					view: opts.view,
					projectId: opts.project ?? null,
					projectSlug: opts.projectSlug ?? null,
				};

				const fmt = opts.format as "table" | "json" | "yaml" | "plain";
				if (fmt === "json" || fmt === "yaml" || fmt === "plain") {
					printOutput(payload, { format: fmt });
					return;
				}

				printRecord({
					"Deep Link": deepLink,
					View: opts.view,
					Project: opts.projectSlug ?? opts.project ?? "(workspace)",
				});
			},
		);

	// -- subscriptions -------------------------------------------------------
	agents
		.command("subscriptions")
		.description(
			"Inspect and verify Remote Fabric Agents Server subscription credits and fallback harnesses",
		)
		.option(
			"--server-url <url>",
			"Remote Fabric Agents Server URL",
			process.env.FABRIC_AGENTS_SERVER_URL ??
				"https://agents.example.com",
		)
		.option(
			"--format <format>",
			"Output format: table|json|yaml|plain",
			"table",
		)
		.option("-q, --quiet", "Print harness IDs only")
		.action(
			async (opts: {
				serverUrl: string;
				format: string;
				quiet?: boolean;
			}) => {
				normalizeValidatedServerUrl(opts.serverUrl);
				const harnesses = [
					{
						id: "claude-max",
						name: "Claude (Opus 4.6 / Sonnet 4.6)",
						billing: "subscription_oauth",
						credits: "active",
						fallbackOrder: 1,
					},
					{
						id: "codex",
						name: "Codex (GPT-5.4 / o3)",
						billing: "subscription_oauth",
						credits: "active",
						fallbackOrder: 2,
					},
					{
						id: "droid-cli",
						name: "Droid (Factory Multi-Model)",
						billing: "subscription_oauth",
						credits: "active",
						fallbackOrder: 3,
					},
					{
						id: "grok-cli",
						name: "Grok (Grok 4 Heavy / Fast)",
						billing: "subscription_oauth",
						credits: "active",
						fallbackOrder: 4,
					},
					{
						id: "kimi-cli",
						name: "Kimi (Kimi K2.5 Thinking)",
						billing: "subscription_oauth",
						credits: "active",
						fallbackOrder: 5,
					},
				];

				if (opts.quiet) {
					for (const h of harnesses) {
						process.stdout.write(`${h.id}\n`);
					}
					return;
				}

				printOutput(harnesses, {
					format: opts.format as "table" | "json" | "yaml" | "plain",
					columns: [
						"id",
						"name",
						"billing",
						"credits",
						"fallbackOrder",
					],
				});
			},
		);

	return agents;
}

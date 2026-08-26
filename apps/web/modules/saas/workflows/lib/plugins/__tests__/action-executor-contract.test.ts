/**
 * The contract between a plugin action and the step that executes it.
 *
 * Four things have to agree, and nothing used to check that they did:
 *
 *   1. the action's `stepImportPath` names a real file under
 *      packages/temporal/src/activities/lib/steps/
 *   2. that file exports the function named by `stepFunction`
 *   3. every field in `outputFields` — which is exactly what the builder's
 *      {{Node.field}} autocomplete offers the user — is actually a key the
 *      step returns
 *   4. an action with no executor declares no binding, and is listed here
 *
 * (3) is the one that bit us: five actions, including Slack, Linear and
 * Resend, advertised fields their steps never returned. Because an unresolved
 * reference used to interpolate to the literal "{{Create Ticket.id}}", the
 * result was a green run that posted a placeholder to a real channel.
 *
 * This test reads step SOURCE rather than executing steps: invoking 40 bespoke
 * HTTP clients would need 40 bespoke mocks, and the failure being guarded here
 * is a naming mismatch that source answers exactly. The one step whose output
 * is not a literal object is listed in OPAQUE_OUTPUT.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import "../../plugins";
import { getAllActions, getAllIntegrations } from "../../plugins";

const STEPS_DIR = join(
	process.cwd(),
	"..",
	"..",
	"packages",
	"temporal",
	"src",
	"activities",
	"lib",
	"steps",
);

/**
 * Actions with no executor yet. They are defined for the integrations UI but
 * cannot run, so they must NOT be offered in the action palette — see the
 * palette test below. Removing an entry here means wiring a real step.
 */
const ACTIONS_WITHOUT_EXECUTORS = new Set([
	"confluence/create-page",
	"confluence/get-page",
	"confluence/list-pages",
	"confluence/search-content",
	"databricks-vector-search/query-index",
	"google-drive/get-document",
	"google-drive/list-files",
	"google-drive/search-files",
	// NB: the folder is microsoft-teams but the integration type is
	// MICROSOFT_GRAPH, and actionId derives from the type.
	"microsoft-graph/get-chat-messages",
	"microsoft-graph/get-shared-files",
	"microsoft-graph/list-channels",
	"microsoft-graph/list-chats",
	"microsoft-graph/list-messages",
	"microsoft-graph/list-teams",
	"microsoft-graph/search-messages",
	"nhtsa-vpic/decode-vin",
	"nhtsa-vpic/decode-vin-batch",
	"nhtsa-vpic/decode-wmi",
	"nhtsa-vpic/get-all-makes",
	"nhtsa-vpic/get-all-manufacturers",
	"nhtsa-vpic/get-manufacturer-details",
	"nhtsa-vpic/get-models-for-make",
	"nhtsa-vpic/get-models-for-make-year",
	"nhtsa-vpic/get-vehicle-types-for-make",
	"notion/create-page",
	"notion/get-page",
	"notion/query-database",
	"notion/search-pages",
]);

/** Steps that build `output` from a variable, so source cannot enumerate keys. */
const OPAQUE_OUTPUT = new Set(["mcp/execute-tool"]);

function stepSource(importPath: string): string | null {
	const file = join(STEPS_DIR, `${importPath}.ts`);
	return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** Top-level keys of each `output: { ... }` literal in a step's source. */
function producedOutputKeys(source: string): Set<string> {
	const keys = new Set<string>();

	for (const match of source.matchAll(/output:\s*\{/g)) {
		let i = (match.index ?? 0) + match[0].length;
		let depth = 1;
		let body = "";
		while (i < source.length && depth > 0) {
			const c = source[i];
			if (c === "{") {
				depth++;
			} else if (c === "}") {
				depth--;
			}
			if (depth > 0) {
				body += c;
			}
			i++;
		}
		for (const entry of splitTopLevel(stripComments(body))) {
			const keyed = entry.match(/^([A-Za-z_$][\w$]*)\s*:/);
			const shorthand = entry.match(/^([A-Za-z_$][\w$]*)$/);
			if (keyed) {
				keys.add(keyed[1]);
			} else if (shorthand) {
				keys.add(shorthand[1]);
			} else if (entry.startsWith("...")) {
				keys.add("<spread>");
			}
		}
	}

	return keys;
}

/** Drop line and block comments so they are not mistaken for entries. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Split an object-literal body on commas at nesting depth 0. */
function splitTopLevel(body: string): string[] {
	const entries: string[] = [];
	let depth = 0;
	let buf = "";
	for (const c of body) {
		if (c === "{" || c === "[" || c === "(") {
			depth++;
		} else if (c === "}" || c === "]" || c === ")") {
			depth--;
		}
		if (c === "," && depth === 0) {
			entries.push(buf.trim());
			buf = "";
		} else {
			buf += c;
		}
	}
	entries.push(buf.trim());
	return entries.filter(Boolean);
}

const actions = getAllActions();
const wired = actions.filter(
	(action) => !ACTIONS_WITHOUT_EXECUTORS.has(action.actionId),
);

describe("plugin hygiene", () => {
	const plugins = getAllIntegrations();

	it("registers every plugin under a distinct integration type", () => {
		const types = plugins.map((p) => p.type);
		expect(types).toHaveLength(new Set(types).size);
	});

	it("gives every plugin at least one action", () => {
		const empty = plugins
			.filter((p) => p.actions.length === 0)
			.map((p) => p.type);
		expect(empty).toEqual([]);
	});

	it("makes every plugin either testable or explicitly untestable", () => {
		// A credential the user cannot verify is indistinguishable from a
		// broken integration. Either offer a test, or say in the plugin that
		// verification happens elsewhere (OAuth status, server-side check).
		const undecided = plugins
			.filter(
				(p) =>
					!(
						p.testConfig?.getTestFunction ||
						p.testConfig?.skipClientTest ||
						p.testConnection
					),
			)
			.map((p) => p.type);

		expect(
			undecided,
			`these plugins neither provide a connection test nor set testConfig.skipClientTest:\n${undecided.join("\n")}`,
		).toEqual([]);
	});

	it("gives every action a label, description and category", () => {
		const incomplete = actions
			.filter((a) => !(a.label && a.description && a.category))
			.map((a) => a.actionId);
		expect(incomplete).toEqual([]);
	});
});

/**
 * Step files that are not plugin action executors: system nodes the builder
 * offers directly, steps driven by other subsystems, and shared helpers.
 * Anything else in the steps directory must be reachable from some action —
 * an executor no action points at is dead weight nobody can run.
 */
const NON_ACTION_STEPS = new Set([
	// system nodes (no integration, no credentials)
	"trigger",
	"condition",
	"http-request",
	// driven by hybrid/browser execution, not offered in the builder palette
	"browser-action",
	"browser-extract",
	"browser-navigate",
	"browser-screenshot",
	"hybrid-step",
	"fabric-enrichment",
	// helpers
	"clerk-shared",
	"gitlab-resolver",
	"index",
	"utils",
]);

describe("every executor is reachable", () => {
	it("has no step file that no action points at", () => {
		const claimed = new Set(
			wired.map((a) => a.stepImportPath).filter(Boolean),
		);
		const files = readdirSync(STEPS_DIR)
			.filter((f) => f.endsWith(".ts"))
			.map((f) => f.slice(0, -3));

		const orphans = files.filter(
			(f) => !(claimed.has(f) || NON_ACTION_STEPS.has(f)),
		);

		expect(
			orphans,
			`these steps exist but no plugin action points at them, so nothing can run them. Either wire an action, or list them in NON_ACTION_STEPS:\n${orphans.join("\n")}`,
		).toEqual([]);
	});
});

describe("node types", () => {
	it("assigns every action a distinct node type", () => {
		const types = actions.map((a) => a.nodeType);
		const dupes = types.filter((t, i) => types.indexOf(t) !== i);
		expect(
			dupes,
			`two actions resolve to the same node type, so one would shadow the other:\n${dupes.join("\n")}`,
		).toEqual([]);
	});

	it("keeps node type and step file in lockstep for wired actions", () => {
		// The executor registry is keyed by node type and each step lives in a
		// file of the same name. Holding the invariant here means the generator
		// (Phase 1) can emit both from one source, and it catches the failure
		// mode where an action is renamed but its stored node type is not.
		const drifted = wired
			.filter((a) => a.nodeType !== a.stepImportPath)
			.map(
				(a) =>
					`${a.actionId}: nodeType=${a.nodeType} step=${a.stepImportPath}`,
			);

		expect(
			drifted,
			`node type and step file name must match:\n${drifted.join("\n")}`,
		).toEqual([]);
	});

	it("pins the node types that predate the <type>-<slug> convention", () => {
		// Regression guard. Deriving these would rename the node in every saved
		// workflow — and they are the most-used nodes in the product.
		const pinned: Record<string, string> = {
			"ai-gateway/generate-text": "ai-generate-text",
			"ai-gateway/generate-image": "ai-generate-image",
			"mcp/execute-tool": "mcp-tool",
			"resend/send-email": "email-send",
			"slack/send-message": "slack-send",
		};

		for (const [actionId, nodeType] of Object.entries(pinned)) {
			const action = actions.find((a) => a.actionId === actionId);
			expect(action, `${actionId} not registered`).toBeDefined();
			expect(action?.nodeType, actionId).toBe(nodeType);
		}
	});
});

describe("plugin action ↔ executor bindings", () => {
	it("finds actions to check", () => {
		expect(actions.length).toBeGreaterThan(50);
		expect(wired.length).toBeGreaterThan(30);
	});

	it("declares a binding for every action that has an executor", () => {
		const missing = wired
			.filter((a) => !(a.stepImportPath && a.stepFunction))
			.map((a) => a.actionId);

		expect(
			missing,
			`these actions declare no stepImportPath/stepFunction. Either wire one, or add them to ACTIONS_WITHOUT_EXECUTORS:\n${missing.join("\n")}`,
		).toEqual([]);
	});

	it("declares NO binding for an action without an executor", () => {
		const lying = actions
			.filter((a) => ACTIONS_WITHOUT_EXECUTORS.has(a.actionId))
			.filter((a) => a.stepImportPath || a.stepFunction)
			.map((a) => a.actionId);

		expect(
			lying,
			`these actions point at a step that does not exist — a binding that cannot be honoured is worse than none:\n${lying.join("\n")}`,
		).toEqual([]);
	});

	it.each(wired.map((a) => [a.actionId, a] as const))(
		"%s resolves to a real step file and exported function",
		(actionId, action) => {
			const source = stepSource(action.stepImportPath as string);
			expect(
				source,
				`${actionId}: no step file at ${action.stepImportPath}.ts`,
			).not.toBeNull();
			expect(
				(source as string).includes(
					`export async function ${action.stepFunction}`,
				),
				`${actionId}: ${action.stepImportPath}.ts does not export ${action.stepFunction}`,
			).toBe(true);
		},
	);
});

describe("declared output fields are actually returned", () => {
	const checkable = wired.filter(
		(a) =>
			(a.outputFields?.length ?? 0) > 0 && !OPAQUE_OUTPUT.has(a.actionId),
	);

	it("has actions with declared outputs to check", () => {
		expect(checkable.length).toBeGreaterThan(30);
	});

	it.each(checkable.map((a) => [a.actionId, a] as const))(
		"%s returns every field it advertises",
		(actionId, action) => {
			const source = stepSource(action.stepImportPath as string);
			expect(source, `${actionId}: step source not found`).not.toBeNull();

			const produced = producedOutputKeys(source as string);
			// A spread means the shape is partly dynamic; only assert what we can.
			if (produced.has("<spread>")) {
				return;
			}

			const declared = (action.outputFields ?? []).map((f) => f.field);
			const missing = declared.filter((field) => !produced.has(field));

			expect(
				missing,
				`${actionId} advertises ${JSON.stringify(missing)} in outputFields, so the builder offers {{Node.${missing[0]}}} for autocomplete — but the step returns ${JSON.stringify([...produced].sort())}. A reference to a field the step never sets resolves to empty.`,
			).toEqual([]);
		},
	);
});

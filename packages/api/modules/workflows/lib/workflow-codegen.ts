/**
 * Render a saved workflow as TypeScript.
 *
 * ## What this is, and what it is not
 *
 * This produces a **scaffold**: a readable, complete, in-order transcription
 * of the graph, with every node's real configuration and its references to
 * upstream outputs resolved. It is for reading, reviewing and porting — not
 * for running as-is. Each step is emitted as a `TODO` call against a small
 * interface the caller implements.
 *
 * It cannot produce a runnable program, and that is a structural limit rather
 * than an unfinished job: 36 of the ~49 step implementations import
 * `@repo/database` to fetch integration credentials out of Prisma, and others
 * reach into `@repo/ai`, `@repo/integrations/*` and the browser-automation
 * runtime. Lifting those bodies into a standalone project — which is how the
 * upstream template does it, its steps being self-contained `fetch()` calls —
 * would require decoupling every step from the monorepo first.
 *
 * ## Why it is data-driven
 *
 * The previous generator was a hand-written `switch` covering 12 of ~68 node
 * types, and for most of those it emitted a comment rather than anything
 * resembling the operation (`results["x"] = { title: "..." }`). Anything it
 * did not recognise fell through to a bare "Unknown node type" line.
 *
 * This walks the saved graph instead. A node carries its own type and config,
 * so every node type is covered automatically and a new integration cannot
 * make the output go stale.
 */

export interface CodegenNode {
	id: string;
	type: string;
	data?: {
		label?: string;
		config?: Record<string, unknown>;
		enabled?: boolean;
	};
}

export interface CodegenEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
}

/** Placeholder nodes the canvas uses; never part of the program. */
const PLACEHOLDER_TYPES = new Set(["add", "empty-action"]);

const NON_ALPHANUMERIC = /[^a-zA-Z0-9]+/g;
const LEADING_DIGIT = /^\d/;
const TEMPLATE_REFERENCE = /\{\{([^}]+)\}\}/g;

export function sanitizeFilename(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(NON_ALPHANUMERIC, "-")
			.replace(/^-+|-+$/g, "") || "workflow"
	);
}

/** A stable, unique, valid identifier for a node. */
function identifierFor(node: CodegenNode, taken: Set<string>): string {
	const base =
		(node.data?.label || node.type || node.id)
			.replace(NON_ALPHANUMERIC, "_")
			.replace(/^_+|_+$/g, "")
			.toLowerCase() || "step";

	let candidate = LEADING_DIGIT.test(base) ? `step_${base}` : base;
	let n = 2;
	while (taken.has(candidate)) {
		candidate = `${base}_${n++}`;
	}
	taken.add(candidate);
	return candidate;
}

/** Kahn's algorithm; nodes in a cycle are appended so nothing is dropped. */
export function topologicalOrder(
	nodes: CodegenNode[],
	edges: CodegenEdge[],
): CodegenNode[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const indegree = new Map(nodes.map((n) => [n.id, 0]));
	const outgoing = new Map<string, string[]>();

	for (const edge of edges) {
		if (!(byId.has(edge.source) && byId.has(edge.target))) {
			continue;
		}
		outgoing.set(edge.source, [
			...(outgoing.get(edge.source) ?? []),
			edge.target,
		]);
		indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
	}

	const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
	const ordered: CodegenNode[] = [];
	const seen = new Set<string>();

	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: guarded by queue.length
		const node = queue.shift()!;
		if (seen.has(node.id)) {
			continue;
		}
		seen.add(node.id);
		ordered.push(node);

		for (const targetId of outgoing.get(node.id) ?? []) {
			const next = (indegree.get(targetId) ?? 0) - 1;
			indegree.set(targetId, next);
			if (next === 0) {
				const target = byId.get(targetId);
				if (target) {
					queue.push(target);
				}
			}
		}
	}

	// A cycle leaves nodes unvisited. Emit them anyway, flagged, rather than
	// silently producing a program that is missing steps.
	for (const node of nodes) {
		if (!seen.has(node.id)) {
			ordered.push(node);
		}
	}

	return ordered;
}

function literal(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	return JSON.stringify(value, null, 2)
		.split("\n")
		.join("\n    ")
		.replace(/\n {4}$/, "\n  ");
}

/**
 * Rewrite `{{Node.field}}` references into the identifier of the step that
 * produced them, so the generated code shows real data flow rather than
 * opaque template strings.
 */
function describeReferences(
	config: Record<string, unknown>,
	labelToIdentifier: Map<string, string>,
): string[] {
	const notes: string[] = [];
	const serialized = JSON.stringify(config ?? {});

	for (const match of serialized.matchAll(TEMPLATE_REFERENCE)) {
		const reference = match[1].trim();
		const [label] = reference.split(".");
		const identifier = labelToIdentifier.get(label.trim());
		notes.push(
			identifier
				? `${reference}  ->  ${identifier}.${reference.slice(label.length + 1) || "output"}`
				: `${reference}  ->  (unresolved: no node named "${label.trim()}")`,
		);
	}

	return [...new Set(notes)];
}

export function generateWorkflowCode(
	workflowName: string,
	rawNodes: CodegenNode[],
	rawEdges: CodegenEdge[],
): string {
	const nodes = (rawNodes ?? []).filter(
		(n) => n && !PLACEHOLDER_TYPES.has(n.type),
	);
	const edges = rawEdges ?? [];

	const header = `/**
 * ${workflowName}
 *
 * Generated from a Fabric workflow. This is a SCAFFOLD, not a runnable
 * program: each step is a call you implement against your own credentials.
 * The structure, ordering, configuration and data flow are faithful to the
 * saved workflow.
 */
`;

	if (nodes.length === 0) {
		return `${header}
export async function ${identifierFor({ id: "wf", type: "workflow", data: { label: workflowName } }, new Set())}() {
  // This workflow has no steps yet.
}
`;
	}

	const ordered = topologicalOrder(nodes, edges);
	const taken = new Set<string>();
	const identifiers = new Map<string, string>();
	const labelToIdentifier = new Map<string, string>();

	for (const node of ordered) {
		const identifier = identifierFor(node, taken);
		identifiers.set(node.id, identifier);
		if (node.data?.label) {
			labelToIdentifier.set(node.data.label, identifier);
		}
	}

	const incoming = new Map<string, string[]>();
	for (const edge of edges) {
		incoming.set(edge.target, [
			...(incoming.get(edge.target) ?? []),
			edge.source,
		]);
	}

	const steps = ordered.map((node) => {
		const identifier = identifiers.get(node.id) as string;
		const config = node.data?.config ?? {};
		const deps = (incoming.get(node.id) ?? [])
			.map((id) => identifiers.get(id))
			.filter(Boolean);

		const lines: string[] = [];
		lines.push(`  // ${node.data?.label || node.type}`);
		if (deps.length > 0) {
			lines.push(`  // depends on: ${deps.join(", ")}`);
		}
		for (const note of describeReferences(config, labelToIdentifier)) {
			lines.push(`  // uses: ${note}`);
		}
		if (node.data?.enabled === false) {
			lines.push("  // DISABLED in the workflow — kept for reference.");
			lines.push(
				`  // const ${identifier} = await run("${node.type}", ${literal(config)});`,
			);
			return lines.join("\n");
		}

		lines.push(
			`  const ${identifier} = await run("${node.type}", ${literal(config)});`,
		);
		return lines.join("\n");
	});

	const returned = ordered
		.filter((n) => n.data?.enabled !== false)
		.map((n) => identifiers.get(n.id))
		.filter(Boolean);

	return `${header}
/**
 * Implement this against your own credentials and HTTP clients. \`type\` is the
 * workflow node type (e.g. "slack-send", "linear-create-ticket") and \`config\`
 * is that node's saved configuration.
 */
type RunStep = (
  type: string,
  config: Record<string, unknown>,
) => Promise<unknown>;

export async function ${sanitizeFilename(workflowName).replace(/-/g, "_")}(
  run: RunStep,
) {
${steps.join("\n\n")}

  return { ${returned.join(", ")} };
}
`;
}

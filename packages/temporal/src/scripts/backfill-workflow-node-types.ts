/**
 * One-shot data migration: namespace legacy workflow-builder node types.
 *
 * Eight steps for five integrations were registered under bare, vendor-less
 * keys — `create-task` (Asana), `create-ticket` (Freshservice),
 * `create-record` (Attio), `create-conversation` / `list-conversations`
 * (Front), `list-designs` (Canva), `list-tasks` (Asana),
 * `search-records` (Attio). Those slugs are not unique across providers:
 * `create-ticket` alone is a slug on Linear, Zendesk and Freshservice, so
 * which one a lookup resolved to depended on Map iteration order.
 *
 * The registry now keys every step by `<integration>-<slug>`. Saved workflows
 * are JSON blobs, so any row written before the rename can still carry the old
 * type. `LEGACY_NODE_TYPE_ALIASES` keeps those rows executing; this script
 * rewrites them so the stored data matches the registry. The alias map stays
 * in place afterwards as the safety net for restored backups.
 *
 * Touches `Workflow.nodes` and `WorkflowVersion.nodes`. `WorkflowExecutionLog`
 * rows are deliberately left alone — they record what actually ran.
 *
 * Idempotent: a row whose nodes contain no legacy type is skipped, and a
 * second run finds nothing to rewrite.
 *
 * Run with:
 *   npx dotenv -c -e .env.local -- pnpm --filter @repo/temporal exec tsx \
 *     src/scripts/backfill-workflow-node-types.ts [--dry-run]
 */

import { pathToFileURL } from "node:url";
import { db, type Prisma } from "@repo/database";
import { LEGACY_NODE_TYPE_ALIASES } from "../workflows/lib/workflow-builder-nodes";

const LEGACY_TYPES = new Set(Object.keys(LEGACY_NODE_TYPE_ALIASES));

type JsonNode = { type?: unknown } & Record<string, unknown>;

/**
 * Rewrite legacy `type` values in a nodes array.
 * Returns null when nothing changed, so callers can skip the write.
 */
export function rewriteNodeTypes(nodes: unknown): JsonNode[] | null {
	if (!Array.isArray(nodes)) {
		return null;
	}

	let changed = false;
	const rewritten = nodes.map((node) => {
		if (!node || typeof node !== "object") {
			return node;
		}
		const typed = node as JsonNode;
		if (typeof typed.type !== "string" || !LEGACY_TYPES.has(typed.type)) {
			return node;
		}
		changed = true;
		return { ...typed, type: LEGACY_NODE_TYPE_ALIASES[typed.type] };
	});

	return changed ? (rewritten as JsonNode[]) : null;
}

export async function runBackfillWorkflowNodeTypes(opts: {
	dryRun: boolean;
}): Promise<{ workflows: number; versions: number }> {
	const { dryRun } = opts;
	console.log(
		`Backfilling legacy workflow node types${dryRun ? " (dry run)" : ""}…`,
	);

	let workflows = 0;
	for (const workflow of await db.workflow.findMany({
		select: { id: true, name: true, nodes: true },
	})) {
		const rewritten = rewriteNodeTypes(workflow.nodes);
		if (!rewritten) {
			continue;
		}
		workflows++;
		console.log(`  · workflow ${workflow.id} (${workflow.name})`);
		if (!dryRun) {
			await db.workflow.update({
				where: { id: workflow.id },
				data: { nodes: rewritten as Prisma.InputJsonValue },
			});
		}
	}

	let versions = 0;
	for (const version of await db.workflowVersion.findMany({
		select: { id: true, workflowId: true, version: true, nodes: true },
	})) {
		const rewritten = rewriteNodeTypes(version.nodes);
		if (!rewritten) {
			continue;
		}
		versions++;
		console.log(
			`  · version ${version.workflowId}@v${version.version} (${version.id})`,
		);
		if (!dryRun) {
			await db.workflowVersion.update({
				where: { id: version.id },
				data: { nodes: rewritten as Prisma.InputJsonValue },
			});
		}
	}

	console.log(
		`Done: ${workflows} workflow(s), ${versions} version(s)${
			dryRun ? " would be rewritten" : " rewritten"
		}`,
	);

	return { workflows, versions };
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	try {
		await runBackfillWorkflowNodeTypes({ dryRun });
	} finally {
		await db.$disconnect();
	}
}

// Only fire `main` when invoked directly via tsx, not when imported by tests.
const entry = process.argv[1];
const invokedDirectly =
	!!entry && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

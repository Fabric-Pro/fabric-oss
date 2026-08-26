/**
 * Workflow-builder node classification, shared by the durable workflow
 * (`workflows/workflow-builder-execution.ts`) and the activity layer
 * (`activities/lib/step-registry.ts`).
 *
 * This module is reachable from a workflow module, so everything it pulls in
 * lands in the Temporal workflow bundle. It MUST stay pure: no I/O, no Node
 * builtins, no `@repo/*` imports, no dynamic `import()`.
 */

/**
 * Node types that WRITE to a connected external source (create/send through
 * stored integration credentials). Read-only mode blocks exactly
 * these while the owning project is read-only — READ steps and internal steps
 * (trigger, condition, ai-*, …) always run. `http-request` (and the browser/
 * hybrid steps) stay out: they target arbitrary URLs, not a connected source.
 * `mcp-tool` is gated separately by its configured tool name — see
 * `executeWorkflowNode`.
 */
export const EXTERNAL_WRITE_NODE_TYPES: ReadonlySet<string> = new Set([
	"asana-create-task",
	"attio-create-record",
	"bitbucket-create-issue",
	"blob-put",
	"clerk-create-user",
	"clerk-delete-user",
	"clerk-update-user",
	"clickup-create-task",
	"email-send",
	"freshservice-create-ticket",
	"front-create-conversation",
	"github-create-issue",
	"gitlab-create-issue",
	"hubspot-create-contact",
	"intercom-create-contact",
	"jira-create-issue",
	"linear-create-ticket",
	"salesforce-create-lead",
	"slack-send",
	"stripe-create-customer",
	"stripe-create-invoice",
	"webflow-publish-site",
	"zendesk-create-ticket",
]);

/**
 * Node types that five integrations were originally registered under, before
 * they were namespaced by integration. The bare slugs collided across
 * providers — `create-ticket` alone was ambiguous between Linear, Zendesk and
 * Freshservice, resolved by map iteration order.
 *
 * Saved workflows are JSON blobs, so rows written before the rename can still
 * carry the old type. Every lookup resolves through here; a backfill
 * (`packages/database/scripts/backfill-workflow-node-types.ts`) rewrites the
 * stored rows, and this map stays as the safety net for restored backups.
 */
export const LEGACY_NODE_TYPE_ALIASES: Readonly<Record<string, string>> = {
	"create-conversation": "front-create-conversation",
	"create-record": "attio-create-record",
	"create-task": "asana-create-task",
	"create-ticket": "freshservice-create-ticket",
	"list-conversations": "front-list-conversations",
	"list-designs": "canva-list-designs",
	"list-tasks": "asana-list-tasks",
	"search-records": "attio-search-records",
};

/**
 * Map a stored node type onto its current canonical name.
 */
export function resolveNodeType(nodeType: string): string {
	return LEGACY_NODE_TYPE_ALIASES[nodeType] ?? nodeType;
}

/**
 * Whether a node type writes to a connected external source.
 */
export function isExternalWriteNodeType(nodeType: string): boolean {
	return EXTERNAL_WRITE_NODE_TYPES.has(resolveNodeType(nodeType));
}

/**
 * Whether an activity failure for this node type may leave a completed side
 * effect behind, making an automatic retry a duplicate rather than a recovery.
 *
 * Steps signal business failures by RETURNING `{ success: false }` — they do
 * not throw — so Temporal only retries on genuine exceptions: a dropped
 * connection, a worker crash, a lost response. Those are exactly the failures
 * where the remote write may already have landed, which is why these node
 * types get `maximumAttempts: 1`.
 *
 * `mcp-tool` is included conservatively: it dispatches an arbitrary tool on a
 * connected external server, and the workflow cannot tell a read from a write
 * without the activity-side name classifier. A lost retry on a read is a far
 * smaller harm than a duplicated write.
 */
export function isNonRetryableNodeType(nodeType: string): boolean {
	const resolved = resolveNodeType(nodeType);
	return resolved === "mcp-tool" || EXTERNAL_WRITE_NODE_TYPES.has(resolved);
}

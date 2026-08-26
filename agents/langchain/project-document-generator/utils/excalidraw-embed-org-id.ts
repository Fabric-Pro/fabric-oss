/**
 * Deterministically stamp the active organization id onto any
 * `<excalidraw-embed>` tag the model emits in a `write_document_local` /
 * `apply_document_patches` tool call.
 *
 * Why this exists: the persisted document content IS the model's tool-call
 * args (verified — the saved embed carries exactly the `data-resource-uri` /
 * `data-config-id` / `data-checkpoint-id` the model wrote). The editor later
 * fetches the diagram scene via `read_checkpoint`, and that lookup is
 * tenant-scoped: without `data-organization-id`, it runs in personal context
 * (`organizationId: null`) and the org-scoped Excalidraw MCP config isn't
 * found → 404 "Couldn't display this diagram". The system prompt instructs
 * the model to copy the org id, but relying on the LLM is a guess. Stamping
 * it here in code makes it a guarantee.
 *
 * Idempotent: a tag that already has a non-empty `data-organization-id` is
 * left untouched; an empty one is filled; a missing one is added.
 */

const EMBED_OPEN_TAG_RE = /<excalidraw-embed\b([^>]*?)(\/?)>/gi;
const ORG_ID_ATTR_RE = /\sdata-organization-id\s*=\s*"([^"]*)"/i;

export function injectOrgIdIntoExcalidrawEmbeds(
	text: string,
	organizationId: string,
): string {
	if (
		!text ||
		!organizationId ||
		!text.toLowerCase().includes("<excalidraw-embed")
	) {
		return text;
	}
	return text.replace(
		EMBED_OPEN_TAG_RE,
		(_full: string, attrs: string, selfClose: string) => {
			const existing = attrs.match(ORG_ID_ATTR_RE);
			let nextAttrs: string;
			if (existing) {
				// Already correct → leave it (idempotent). Empty value → fill it.
				nextAttrs = existing[1]?.trim()
					? attrs
					: attrs.replace(
							ORG_ID_ATTR_RE,
							` data-organization-id="${organizationId}"`,
						);
			} else {
				nextAttrs = `${attrs.replace(/\s+$/, "")} data-organization-id="${organizationId}"`;
			}
			return `<excalidraw-embed${nextAttrs}${selfClose}>`;
		},
	);
}

/**
 * Recursively walk a tool call's `args` and stamp the org id onto every
 * `<excalidraw-embed>` found in any string value. Field-name agnostic so it
 * works for both `write_document_local` (`{ content }`) and
 * `apply_document_patches` (`{ patches: [{ ... }] }`) without coupling to
 * their exact arg shapes.
 */
export function injectOrgIdIntoToolArgs<T>(args: T, organizationId: string): T {
	if (!organizationId) {
		return args;
	}
	if (typeof args === "string") {
		return injectOrgIdIntoExcalidrawEmbeds(
			args,
			organizationId,
		) as unknown as T;
	}
	if (Array.isArray(args)) {
		return args.map((item) =>
			injectOrgIdIntoToolArgs(item, organizationId),
		) as unknown as T;
	}
	if (args && typeof args === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			args as Record<string, unknown>,
		)) {
			out[key] = injectOrgIdIntoToolArgs(value, organizationId);
		}
		return out as T;
	}
	return args;
}

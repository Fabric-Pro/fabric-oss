/**
 * What a Fabric tool is, as one typed shape, and the three questions every
 * surface asks of it: does this call need the person's yes, does it only read,
 * and can it be tried first with `dryRun`.
 *
 * The Fabric MCP gateway serves these definitions to its clients; the
 * Orchestrator's catalogue indexes them; Direct chat reads them back off the
 * wire. Each of those used to work the answers out from the raw metadata in its
 * own way, and they disagreed (Direct asked for four writes, the Orchestrator
 * for seven). The answers live here, once, so a tool is asked about the same
 * way wherever it is called.
 *
 * Pure data and functions with no imports (no zod either), so the web app, the
 * worker and the workflow sandbox can all import it through
 * `@repo/temporal/fabric-tool-definition`.
 */

/**
 * When a call to a tool needs the person's yes before it runs:
 * - `"always"`: every call, whatever its arguments;
 * - `{ whenArgumentPresent }`: only a call that sets that argument to something
 *   (a non-empty list, string or object, a number or a boolean), for tools that
 *   are harmless until they are given a power.
 */
export type ConfirmationPolicy = "always" | { whenArgumentPresent: string };

interface ToolAnnotations {
	readOnlyHint: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
}

/**
 * What a call does, as far as the page host is concerned when a page makes it:
 * - `store-read` reads what the page keeps (records, files, comments);
 * - `store-write` changes it, which other people on the page see;
 * - `taints` learns something beyond the page's own store (who the viewer is);
 * - `asks-once` is not a change to data but reaches the viewer's accounts or
 *   spends their allowance, so the host asks once per page version, and it also
 *   taints.
 */
export type PageEffect = "store-read" | "store-write" | "taints" | "asks-once";

export interface FabricToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: ToolAnnotations;
	/** The gateway scope a caller needs, e.g. `workflows:write`. */
	scope: string;
	confirm?: ConfirmationPolicy;
	/**
	 * Only a page's script has a use for the tool, so the chat engines do not
	 * offer it to their model; the gateway serves it and checks it like any other.
	 */
	pageOnly?: true;
	/** How the page host treats a page's call to the tool; set on every page tool. */
	page?: PageEffect;
}

/** The annotation sets a tool is declared with: what it reads or changes, and whether a repeat is safe. */
export const TOOL_ANNOTATIONS = {
	read: { readOnlyHint: true },
	write: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
	},
	idempotentWrite: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
	},
	rewrite: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
} as const;

/** Keeps each tool's literal name in the type, so a table keyed by name is checked against the list. */
export function defineFabricTools<
	const T extends readonly FabricToolDefinition[],
>(tools: T): T {
	return tools;
}

/** The `_meta` key an MCP client reads a tool's confirmation policy from. */
const CONFIRM_META_KEY = "fabric/confirm";

/** A confirmation policy as it travels in a tool's MCP `_meta`. */
export interface ConfirmationMeta {
	"fabric/confirm": true | { whenArgumentPresent: string };
}

/** The tool's `_meta` on the wire, or undefined for a tool that never asks. */
export function confirmationMeta(tool: {
	name: string;
	confirm?: ConfirmationPolicy;
}): ConfirmationMeta | undefined {
	if (!tool.confirm) {
		return undefined;
	}
	return {
		[CONFIRM_META_KEY]: tool.confirm === "always" ? true : tool.confirm,
	};
}

/**
 * The policy a tool's `_meta` carries, read back off the wire. A tool that
 * names the key asked the question: a shape this reader does not understand is
 * read as "every call", never as no question, so a value from a newer gateway
 * cannot switch it off.
 */
export function readConfirmationPolicy(
	meta: unknown,
): ConfirmationPolicy | undefined {
	if (
		typeof meta !== "object" ||
		meta === null ||
		!(CONFIRM_META_KEY in meta)
	) {
		return undefined;
	}
	const value = (meta as Record<string, unknown>)[CONFIRM_META_KEY];
	if (typeof value === "object" && value !== null) {
		const argument = (value as Record<string, unknown>).whenArgumentPresent;
		if (typeof argument === "string" && argument.length > 0) {
			return { whenArgumentPresent: argument };
		}
	}
	return value === false || value === undefined || value === null
		? undefined
		: "always";
}

function isPresent(value: unknown): boolean {
	if (value === undefined || value === null) {
		return false;
	}
	if (typeof value === "string") {
		return value.trim().length > 0;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (typeof value === "object") {
		return Object.keys(value).length > 0;
	}
	return true;
}

/** Whether this call, with these arguments, needs the person's yes first. */
export function confirmationRequired(
	policy: ConfirmationPolicy | undefined,
	args: Record<string, unknown>,
): boolean {
	if (!policy) {
		return false;
	}
	if (policy === "always") {
		return true;
	}
	return isPresent(args[policy.whenArgumentPresent]);
}

/**
 * Whether this call to this tool needs the person's yes first: the tool's own
 * policy against the call's arguments, except that a `dryRun` of a tool that
 * takes one writes nothing, so it asks nothing — the person is asked for the
 * real call once they have seen the draft. The one answer both chat engines
 * read; a listing off the wire passes `confirm: readConfirmationPolicy(_meta)`.
 */
export function callNeedsConfirmation(
	tool: {
		confirm?: ConfirmationPolicy;
		inputSchema?: { properties?: Record<string, unknown> };
	},
	args: Record<string, unknown>,
): boolean {
	if (supportsDryRun(tool) && args.dryRun === true) {
		return false;
	}
	return confirmationRequired(tool.confirm, args);
}

/** READ only for a tool whose definition says it only reads; every other tool writes. */
export function toolAccess(tool: {
	annotations?: { readOnlyHint?: boolean };
}): "READ" | "WRITE" {
	return tool.annotations?.readOnlyHint === true ? "READ" : "WRITE";
}

/**
 * A tool's input schema as Fabric's chat shows it to its model: without
 * `dryRun`. In chat the approval card is the draft the person decides on, so a
 * model that drafts with `dryRun` first and asks in prose loses the draft
 * between turns and has nothing to save when the person says yes. The chat
 * engines make the real call, and the call that needs a yes comes back as the
 * card. Clients that see `dryRun` (external MCP clients) are served the full
 * schema.
 */
export function withoutDryRun<S extends Record<string, unknown>>(
	inputSchema: S,
): S {
	const { properties } = inputSchema;
	if (typeof properties !== "object" || properties === null) {
		return inputSchema;
	}
	return {
		...inputSchema,
		properties: Object.fromEntries(
			Object.entries(properties).filter(([name]) => name !== "dryRun"),
		),
	};
}

/** The sentence a tool's description uses to offer `dryRun`. */
const DRY_RUN_NOTE = /\s*`dryRun` writes nothing\./;

/** A tool's description without its offer of `dryRun`; see `withoutDryRun`. */
export function withoutDryRunNote(description: string): string {
	return description.replace(DRY_RUN_NOTE, "");
}

/** Whether the tool takes `dryRun`: the call it can be tried with, which writes nothing. */
export function supportsDryRun(tool: {
	inputSchema?: { properties?: Record<string, unknown> };
}): boolean {
	return tool.inputSchema?.properties?.dryRun !== undefined;
}

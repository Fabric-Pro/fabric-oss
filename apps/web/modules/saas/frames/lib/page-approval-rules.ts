import {
	ASKS_ONCE,
	PAGE_SHARED_WRITES,
	PAGE_STORE_READS,
	TAINTING_TOOLS,
} from "@repo/temporal/fabric-page-tool-definitions";

/**
 * When the host asks the viewer before it runs a tool a page asked for, and when
 * it takes a page to have seen more than its own data. Pure, so the host and its
 * tests share one table instead of each re-deriving it. Which tool is which
 * comes from the tool definitions themselves, so a new page tool needs no entry
 * here.
 *
 * Three answers:
 * - `never`: the call runs at once (reading, and the page's own reads);
 * - `once`: the viewer is asked, and a yes covers the tool on this version of the
 *   page for the browser session;
 * - `every`: the viewer is asked on every call, and a yes covers that call only.
 */
type AskMode = "never" | "once" | "every";

/** Why the viewer is asked on every call, not once, for a tool. */
export type ConfirmEveryBecause = "tainted" | "keeps-data" | "confirm";

interface AskDecision {
	mode: AskMode;
	/** Set when `mode` is `every`. */
	because?: ConfirmEveryBecause;
}

const PAGE_STORE_TOOLS: ReadonlySet<string> = new Set([
	...PAGE_STORE_READS,
	...PAGE_SHARED_WRITES,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does this call write only records the viewer keeps for themselves
 * (`scope: "mine"`)? Nobody else on the page can read those, so they cannot
 * carry what the page has read to anyone else.
 */
function writesOnlyOwnRecords(
	name: string,
	args: Record<string, unknown>,
): boolean {
	return (
		name === "fabric_page_data_set" &&
		Array.isArray(args.records) &&
		args.records.length > 0 &&
		args.records.every(
			(record) => isRecord(record) && record.scope === "mine",
		)
	);
}

/**
 * A page that has read outside its own store could be putting what it read into
 * any change it asks for: a story, a workflow, a comment, a shared record. So
 * once it is tainted every call that is not a plain read asks again, with that
 * call's values shown, and a yes covers that call only. The one exception is a
 * write to records kept as the viewer's own. A tool whose own definition says
 * to ask on this call (`confirmEveryCall`) asks on every call, whatever else
 * holds.
 */
export function askModeFor(input: {
	name: string;
	args: Record<string, unknown>;
	/** The tool list marks the tool as one that only reads. */
	readOnly: boolean;
	/** The page has read something outside its own store (see `taintsPage`). */
	tainted: boolean;
	/** The page declared at least one tool that keeps shared data. */
	declaresStoreTools: boolean;
	/** The tool's definition says to ask before this call. */
	confirmEveryCall: boolean;
}): AskDecision {
	const { name, args, readOnly, tainted, declaresStoreTools } = input;
	if (input.confirmEveryCall) {
		return { mode: "every", because: tainted ? "tainted" : "confirm" };
	}
	const asks = !readOnly || ASKS_ONCE.has(name);
	if (!asks) {
		return { mode: "never" };
	}
	if (tainted && !writesOnlyOwnRecords(name, args)) {
		return { mode: "every", because: "tainted" };
	}
	if (ASKS_ONCE.has(name)) {
		return { mode: "once" };
	}
	// Records the page keeps can hold anything a viewer typed; a page that keeps
	// them is held to a question per call for every other write, so data cannot
	// be turned into a standing permission.
	if (declaresStoreTools && !PAGE_STORE_TOOLS.has(name)) {
		return { mode: "every", because: "keeps-data" };
	}
	return { mode: "once" };
}

/**
 * Has the page, by this successful call, seen more than the records, files and
 * comments it keeps itself? The viewer, their connected accounts and an answer
 * from the model all are, and so is any other Fabric data it reads.
 */
export function taintsPage(name: string, readOnly: boolean): boolean {
	if (TAINTING_TOOLS.has(name)) {
		return true;
	}
	if (PAGE_STORE_TOOLS.has(name)) {
		return false;
	}
	return readOnly;
}

export function declaresStoreTools(declared: ReadonlySet<string>): boolean {
	for (const name of declared) {
		if (PAGE_STORE_TOOLS.has(name)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a page has read outside its own store. Kept by whoever owns the page
 * on screen, not by the host that decides, so a host made again for the same
 * page (the viewer switched organization and back) does not forget it. Another
 * version of the page, or a reload, starts over (`reset`).
 */
export interface PageTaint {
	isTainted: () => boolean;
	mark: () => void;
	reset: () => void;
}

export function createPageTaint(): PageTaint {
	let tainted = false;
	return {
		isTainted: () => tainted,
		mark: () => {
			tainted = true;
		},
		reset: () => {
			tainted = false;
		},
	};
}

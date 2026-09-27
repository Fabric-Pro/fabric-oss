/**
 * The shared repository-sync selection tree's row model (Fizzy #2750 §3.1).
 * Pure: `RepositorySyncSelectionTree` renders it, and each feature's adapter
 * (`./instructions-selection` for Coding Instructions, `./context-selection`
 * for Living Memory) computes it over the FULL listing and selection, never
 * over the search results or the rows a member happened to expand.
 */
import type { RepositoryTreeEntry } from "./repository-tree";

/**
 * Whether a row syncs:
 *  - `in`: it syncs (a ticked box);
 *  - `out`: it does not (an empty box);
 *  - `mixed`: a folder that is partly in — it holds something the member
 *    left out, or (Living Memory) it is not selected itself but holds
 *    selected paths. Rule-based skips (`node_modules`, a symbolic link, a
 *    file that is not text) never make a folder mixed;
 *  - `unknown`: the rules that decide it are not known yet, or could not be
 *    read (Coding Instructions: the `.fabricignore` or the project's rules).
 */
export type SelectionMembership = "in" | "out" | "mixed" | "unknown";

/**
 * A translation key with its values, relative to the feature's
 * repository-sync namespace (`projects.codingInstructions.repositorySync` or
 * `projects.contexts.livingMemory.repositorySync`).
 */
export type SelectionMessage = {
	key: string;
	values?: Record<string, string | number>;
	/** Values that are messages themselves, translated first. */
	fragments?: Record<string, SelectionMessage>;
};

/** A translator bound to the feature's namespace (next-intl's `t`). */
export type SelectionTranslator = (
	key: string,
	values?: Record<string, string | number>,
) => string;

/** `message` in the feature's words, its fragments translated first. */
export function translateSelectionMessage(
	t: SelectionTranslator,
	message: SelectionMessage,
): string {
	if (!message.fragments) {
		return message.values ? t(message.key, message.values) : t(message.key);
	}
	const values: Record<string, string | number> = { ...message.values };
	for (const [name, fragment] of Object.entries(message.fragments)) {
		values[name] = translateSelectionMessage(t, fragment);
	}
	return t(message.key, values);
}

/** One row as the tree shows it. */
export type SelectionRow = {
	membership: SelectionMembership;
	/**
	 * `null` when the box can be clicked; otherwise why not, shown under the
	 * row and wired to the box with `aria-describedby`. An `unknown` row is
	 * never clickable; without a reason of its own it says it can't tell yet.
	 */
	disabledReason: SelectionMessage | null;
	/** Something a clickable row should say, wired the same way. */
	note?: SelectionMessage | null;
};

/**
 * The summary under the tree (Fizzy #2750 §6): what will sync, a live count
 * that never promises the number, and what the count cannot see.
 */
export type SelectionSummaryModel = {
	/** Set when nothing is ticked: the only line, and Save's reason. */
	nothingSelected: SelectionMessage | null;
	lead: SelectionMessage | null;
	/** The live count, or what stands in for it. */
	count: SelectionMessage | null;
	notes: readonly SelectionMessage[];
};

/** The box state Radix renders for a membership. */
export function checkboxStateOf(
	membership: SelectionMembership,
): boolean | "indeterminate" {
	if (membership === "in") {
		return true;
	}
	return membership === "mixed" ? "indeterminate" : false;
}

/**
 * What the tree area shows for the branch's listing: nothing to list yet
 * (no repository or branch), a listing in flight, a refusal (in the
 * feature's own words), a provider with no listing, or the entries.
 */
export type SelectionTreeListing =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; message: SelectionMessage }
	| { status: "unsupported" }
	| {
			status: "ready";
			entries: readonly RepositoryTreeEntry[];
			truncated: boolean;
	  };

/**
 * The listing state of one `listTree` read: `enabled` is whether the read is
 * allowed to run (a settled branch of a chosen repository), and
 * `errorMessage` words a failure as the feature's configure dialog does.
 */
export function selectionTreeListingOf<
	TEntry extends RepositoryTreeEntry,
>(input: {
	/** There is a repository and a branch to list. */
	requested: boolean;
	/** The read may run: the branch has settled. */
	enabled: boolean;
	query: {
		isPending: boolean;
		isError: boolean;
		error: unknown;
		data:
			| { supported: boolean; entries: TEntry[]; truncated: boolean }
			| undefined;
	};
	errorMessage: (error: unknown) => SelectionMessage;
}): SelectionTreeListing {
	if (!input.requested) {
		return { status: "idle" };
	}
	if (!input.enabled || input.query.isPending) {
		return { status: "loading" };
	}
	if (input.query.isError) {
		return {
			status: "error",
			message: input.errorMessage(input.query.error),
		};
	}
	const data = input.query.data;
	if (!data?.supported) {
		return { status: "unsupported" };
	}
	return {
		status: "ready",
		entries: data.entries,
		truncated: data.truncated,
	};
}

/**
 * Whether the typed "Add a path" input is offered: where the tree cannot
 * reach every path — a provider with no listing, a truncated listing, or a
 * listing that failed (Fizzy #2750 §3.2).
 */
export function offersTypedPath(listing: SelectionTreeListing): boolean {
	return (
		listing.status === "unsupported" ||
		listing.status === "error" ||
		(listing.status === "ready" && listing.truncated)
	);
}

// packages/temporal/src/lib/resolve-backlog-update-target.ts

/** Minimal shape the resolver needs from a backlog item. */
export interface ResolvableBacklogItem {
	id: string;
	identifier: string;
	title: string;
	externalId?: string | null;
}

/** Minimal shape the resolver needs from a proposed change. */
export interface ResolvableChange {
	existingId?: string | null;
	existingIdentifier?: string | null;
	existingExternalId?: string | null;
	title: { from?: string | null; to: string };
}

export type ResolveResult =
	| {
			status: "resolved";
			storyId: string;
			identifier: string;
			title: string;
			resolvedBy: "id" | "identifier" | "externalId" | "title";
	  }
	| { status: "unresolved" };

/** A Fabric DB id is a CUID (`c…`, 25+ chars) or a UUID. */
export function isFabricDbId(value: string | null | undefined): boolean {
	if (!value) {
		return false;
	}
	return (
		/^c[a-z0-9]{24,}$/.test(value) ||
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}

/**
 * Resolve a proposed "update" change to a concrete backlog item, mirroring the
 * apply-time strategies: valid Fabric id present in the snapshot → identifier →
 * externalId → exact case-insensitive title. Pure and total — returns
 * `{ status: "unresolved" }` rather than throwing when nothing matches.
 */
export function resolveBacklogUpdateTarget(
	items: ResolvableBacklogItem[],
	change: ResolvableChange,
): ResolveResult {
	const resolved = (
		item: ResolvableBacklogItem,
		resolvedBy: "id" | "identifier" | "externalId" | "title",
	): ResolveResult => ({
		status: "resolved",
		storyId: item.id,
		identifier: item.identifier,
		title: item.title,
		resolvedBy,
	});

	// Strategy 1: a valid Fabric id that actually exists in the snapshot.
	if (isFabricDbId(change.existingId)) {
		const byId = items.find((i) => i.id === change.existingId);
		if (byId) {
			return resolved(byId, "id");
		}
	}

	// Strategy 2: by identifier (e.g. "F-2").
	if (change.existingIdentifier) {
		const byIdent = items.find(
			(i) => i.identifier === change.existingIdentifier,
		);
		if (byIdent) {
			return resolved(byIdent, "identifier");
		}
	}

	// Strategy 3: by PM-tool externalId.
	if (change.existingExternalId) {
		const byExt = items.find(
			(i) => i.externalId === change.existingExternalId,
		);
		if (byExt) {
			return resolved(byExt, "externalId");
		}
	}

	// Strategy 4: exact case-insensitive title (prefer the "from" title).
	const titleToMatch = (
		change.title.from ||
		change.title.to ||
		""
	).toLowerCase();
	if (titleToMatch) {
		const byTitle = items.find(
			(i) => i.title.toLowerCase() === titleToMatch,
		);
		if (byTitle) {
			return resolved(byTitle, "title");
		}
	}

	return { status: "unresolved" };
}

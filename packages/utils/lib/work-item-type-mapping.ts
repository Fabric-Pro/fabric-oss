// Fabric models exactly two story kinds: the "User Story" kind was retired
// (DSU 2026-05-23) and its rows migrated to FEATURE, so the Prisma `StoryKind`
// enum is `FEATURE | BUG`. Anything that isn't a bug must resolve to FEATURE —
// emitting a third value makes `createStory` throw at the DB layer (#1305).
export type StoryKindValue = "BUG" | "FEATURE";

export type WorkItemTypeMapping = Partial<Record<StoryKindValue, string>>;

export interface ResolveWorkItemTypeOptions {
	mapping?: WorkItemTypeMapping | null;
	availableTypes?: readonly string[] | null;
	legacyFallback: string;
}

const STORY_KINDS: readonly StoryKindValue[] = ["BUG", "FEATURE"];

export const DEFAULT_TYPE_PRIORITY: Record<StoryKindValue, readonly string[]> =
	{
		BUG: ["Bug", "Defect"],
		FEATURE: ["Feature", "Epic", "User Story"],
	};

export function resolveWorkItemType(
	kind: StoryKindValue,
	opts: ResolveWorkItemTypeOptions,
): string {
	const override = opts.mapping?.[kind]?.trim();
	if (override) {
		return override;
	}
	const { availableTypes } = opts;
	if (availableTypes && availableTypes.length > 0) {
		const byLower = new Map(
			availableTypes.map((t) => [t.toLowerCase(), t] as const),
		);
		for (const candidate of DEFAULT_TYPE_PRIORITY[kind]) {
			const hit = byLower.get(candidate.toLowerCase());
			if (hit) {
				return hit;
			}
		}
	}
	return opts.legacyFallback;
}

export function resolveKindFromPmType(
	pmType: string | null | undefined,
	mapping?: WorkItemTypeMapping | null,
): StoryKindValue {
	const normalized = (pmType ?? "").trim().toLowerCase();
	if (!normalized) {
		return "FEATURE";
	}
	if (mapping) {
		for (const kind of STORY_KINDS) {
			const mapped = mapping[kind];
			if (mapped && mapped.trim().toLowerCase() === normalized) {
				return kind;
			}
		}
	}
	if (normalized === "bug" || normalized === "defect") {
		return "BUG";
	}
	// Every non-bug PM type (User Story, Feature, Epic, Task, Issue, …) collapses
	// to the single remaining non-bug kind.
	return "FEATURE";
}

export function parseWorkItemTypeMapping(
	additionalContext: Record<string, unknown> | null | undefined,
): WorkItemTypeMapping {
	const out: WorkItemTypeMapping = {};
	const raw = additionalContext?.workItemTypeMapping;
	if (raw && typeof raw === "object") {
		const rec = raw as Record<string, unknown>;
		for (const kind of STORY_KINDS) {
			const value = rec[kind];
			if (typeof value === "string" && value.trim()) {
				out[kind] = value.trim();
			}
		}
	}
	return out;
}

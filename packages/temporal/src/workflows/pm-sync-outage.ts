export const PM_SYNC_OUTAGE_THRESHOLD = 3;

export type PmSyncOutageItemType = "epic" | "feature" | "story" | "bug";

export interface PmSyncFailedItem {
	id: string;
	itemType: PmSyncOutageItemType;
	errorClass: string;
}

export interface PmSyncOutageItem {
	id: string;
	itemType: PmSyncOutageItemType;
}

export interface PmSyncOutage {
	tool: string;
	errorClass: string;
	count: number;
	items: PmSyncOutageItem[];
}

/**
 * Group FAILED PM-sync results by `errorClass`. Return the first group whose
 * count meets `PM_SYNC_OUTAGE_THRESHOLD`. CONFLICT and SUCCESS are not
 * candidates for rollup.
 */
export function computePmSyncOutage(
	failed: PmSyncFailedItem[],
	tool: string,
): PmSyncOutage | undefined {
	if (failed.length < PM_SYNC_OUTAGE_THRESHOLD) {
		return undefined;
	}
	const groups = new Map<string, PmSyncOutageItem[]>();
	for (const item of failed) {
		const entry = { id: item.id, itemType: item.itemType };
		const existing = groups.get(item.errorClass);
		if (existing) {
			existing.push(entry);
		} else {
			groups.set(item.errorClass, [entry]);
		}
	}
	for (const [errorClass, items] of groups) {
		if (items.length >= PM_SYNC_OUTAGE_THRESHOLD) {
			return {
				tool,
				errorClass,
				count: items.length,
				items,
			};
		}
	}
	return undefined;
}

/** What a refused or failed report deletion means for the person who asked. */
export type ReportDeleteFailure =
	| { kind: "gone"; message: string }
	| { kind: "forbidden"; message: string }
	| { kind: "failed"; message: string };

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

/**
 * Only a refusal for permission says so. A report the server no longer finds
 * for the caller is gone from their view, deleted already or no longer open to
 * them, and anything else is a failure worth trying again: neither is
 * described as a missing permission.
 */
export function reportDeleteFailure(error: unknown): ReportDeleteFailure {
	switch (errorCode(error)) {
		case "NOT_FOUND":
			return {
				kind: "gone",
				message:
					"This report was already deleted, or you can no longer open it.",
			};
		case "FORBIDDEN":
		case "UNAUTHORIZED":
			return {
				kind: "forbidden",
				message: "You don't have permission to delete this report.",
			};
		default:
			return {
				kind: "failed",
				message: "Couldn't delete this report. Please try again.",
			};
	}
}

export type ReportListPage = {
	instances: Array<{ id: string; isActive?: boolean }>;
	total: number;
	activeTotal?: number | null;
};

/** A cached report list without the report being deleted. */
export function withoutReport<T extends ReportListPage>(
	page: T | undefined,
	reportId: string,
): T | undefined {
	if (!page) {
		return page;
	}
	const removed = page.instances.find((report) => report.id === reportId);
	if (!removed) {
		return page;
	}
	return {
		...page,
		instances: page.instances.filter((report) => report.id !== reportId),
		total: Math.max(0, page.total - 1),
		...(typeof page.activeTotal === "number" && removed.isActive
			? { activeTotal: Math.max(0, page.activeTotal - 1) }
			: {}),
	};
}

/**
 * The viewer's "allow" for a tool a page's script wants to run, remembered for
 * the browser session. It is kept per page *version* and tool: the page's
 * author can change the page, and a yes given to what the page was does not
 * carry over to what it has become (see `frameContentFingerprint`).
 */

const APPROVALS_STORAGE_KEY = "fabric-frame-runtime-approvals";

const memoryApprovals = new Map<string, Set<string>>();

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function storedApprovals(): Record<string, string[]> {
	try {
		const raw = window.sessionStorage.getItem(APPROVALS_STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const approvals: Record<string, string[]> = {};
		for (const [key, tools] of Object.entries(parsed)) {
			if (isStringArray(tools)) {
				approvals[key] = tools;
			}
		}
		return approvals;
	} catch {
		return {};
	}
}

/** The key of one version of one page: its id and what its content hashes to. */
export function approvalKeyOf(
	frameKey: string,
	contentFingerprint: string,
): string {
	return `${frameKey}@${contentFingerprint}`;
}

export function isApproved(approvalKey: string, toolName: string): boolean {
	return (
		memoryApprovals.get(approvalKey)?.has(toolName) === true ||
		storedApprovals()[approvalKey]?.includes(toolName) === true
	);
}

/** Remembers a yes for this page version and tool until the browser session ends. */
export function approve(approvalKey: string, toolName: string): void {
	const approved = memoryApprovals.get(approvalKey) ?? new Set<string>();
	approved.add(toolName);
	memoryApprovals.set(approvalKey, approved);
	try {
		const stored = storedApprovals();
		stored[approvalKey] = [
			...new Set([...(stored[approvalKey] ?? []), toolName]),
		];
		window.sessionStorage.setItem(
			APPROVALS_STORAGE_KEY,
			JSON.stringify(stored),
		);
	} catch {
		// Without session storage the approval lasts until the page reloads.
	}
}

export type SendBadgeVariant =
	| "success"
	| "info"
	| "warning"
	| "error"
	| "secondary";

/**
 * Maps a NewsletterSend (status, skipReason) to a human-readable label + Badge
 * variant. Pure + total: unknown statuses/reasons fall back to a neutral label,
 * never throw. `skipReason` is a plain string (DB column) — tolerant by design.
 */
export function formatNewsletterSendStatus(
	status: string,
	skipReason?: string | null,
	/**
	 * The send's frozen `requireApproval`.
	 *
	 * On a gated project PENDING is the PRE-review state: the workflow is
	 * gathering merged pull requests and running curation, and
	 * `holdNewsletterForApproval` moves the row to PENDING_APPROVAL afterwards.
	 * Labelling that "Sending…" tells the reviewer the issue already went out,
	 * and a worker that dies mid-curation leaves the row asserting it forever
	 * (Fizzy #2172).
	 *
	 * Optional: omitting it reproduces the previous output exactly, so call
	 * sites without the field keep working.
	 */
	requireApproval?: boolean,
): { label: string; variant: SendBadgeVariant } {
	switch (status) {
		case "SENT":
			return { label: "Sent", variant: "success" };
		case "PENDING":
			return requireApproval
				? { label: "Preparing…", variant: "info" }
				: { label: "Sending…", variant: "info" };
		case "PARTIAL":
			return { label: "Partially sent", variant: "warning" };
		case "FAILED":
			return { label: "Failed", variant: "error" };
		// Approval-gate statuses (Fizzy 1869). Without these cases the raw enum
		// (e.g. "PENDING_APPROVAL") leaks into the badge.
		case "PENDING_APPROVAL":
			return { label: "Awaiting review", variant: "warning" };
		case "APPROVED":
			return { label: "Approved", variant: "info" };
		case "REJECTED":
			return { label: "Rejected", variant: "secondary" };
		case "EXPIRED":
			return { label: "Review expired", variant: "secondary" };
		case "SKIPPED_EMPTY":
			switch (skipReason) {
				case "NO_ACTIVE_REPOS":
					return {
						label: "Repositories disconnected",
						variant: "warning",
					};
				case "NO_RELEASES":
					return { label: "No new releases", variant: "secondary" };
				case "NO_MAJOR_FEATURES":
					return { label: "No major updates", variant: "secondary" };
				case "INCOMPLETE_SCAN":
					return { label: "Scan incomplete", variant: "warning" };
				case "NO_SUBSCRIBERS":
					return { label: "No subscribers", variant: "warning" };
				case "NO_CHAT_TARGETS":
					return { label: "No chat channels", variant: "warning" };
				default:
					return { label: "Skipped", variant: "secondary" };
			}
		default:
			return { label: status, variant: "secondary" };
	}
}

/**
 * Maps a chat-delivery row status to a badge label + variant.
 *
 * TWO callers since Fizzy #1850 1C-4b — the newsletter send history and the
 * publishing refresh history — and they do NOT share `SENDING` semantics, so
 * read the paragraph below as being about the newsletter writer only.
 *
 * For the NEWSLETTER ledger, SENDING is not "skipped": that delivery activity
 * leaves a row at SENDING only when the worker died between a successful post
 * and the confirming write, and it deliberately counts such rows as sent
 * (posting twice is worse than an unconfirmed count). Labelling it "Skipped"
 * would tell an operator the message was never sent when it most likely was.
 *
 * For the PUBLISHING broadcast the prior is inverted: that activity claims the
 * row BEFORE contacting the provider (broadcast-topics-to-chat.ts:524 vs
 * :569/:593), so a SENDING row there does not imply a delivered message — see
 * `describePublishingChatDelivery` for the copy that says so. The label
 * "Unconfirmed" is honest for both, which is why the function is shared; the
 * explanation is not, which is why it is scoped here.
 */
export function formatChatDeliveryStatus(status: string): {
	label: string;
	variant: SendBadgeVariant;
} {
	switch (status) {
		case "SENT":
			return { label: "Delivered", variant: "success" };
		case "FAILED":
			return { label: "Failed", variant: "error" };
		case "SENDING":
			return { label: "Unconfirmed", variant: "warning" };
		case "SKIPPED":
			return { label: "Skipped", variant: "secondary" };
		default:
			return { label: status, variant: "secondary" };
	}
}

/** True if any repo integration is not ACTIVE (expired/error/disconnected). */
export function hasExpiredRepoIntegrations(
	integrations: ReadonlyArray<{ status: string }>,
): boolean {
	return integrations.some((i) => i.status !== "ACTIVE");
}

/**
 * Predicate for `queryClient.invalidateQueries` that matches ONLY the
 * `newsletter.sends.list` query for the given project (any page, any filter,
 * any page size).
 *
 * oRPC key shape (v1.13.x): `[path, { type, input }]`
 * where path = `["newsletter", "sends", "list"]` and input carries the tenant
 * fields (`projectId`, `organizationId`) plus paging/filter fields we ignore.
 *
 * Two checks, both required:
 *  1. The procedure path (`queryKey[0]`) must END WITH `["newsletter","sends","list"]`.
 *     Checking only a trailing "list" is NOT enough — `subscribers.list` ends in
 *     "list" too — so the "sends" segment is also asserted. Without this, sibling
 *     queries (`settings.get`, `subscribers.list`, repo integrations) that share
 *     the same `{projectId, organizationId}` input would be over-invalidated.
 *  2. The input object (scanned from the key) must match `projectId` +
 *     `organizationId`, ignoring paging/filter fields.
 */
export function isSendsListKeyForProject(
	queryKey: readonly unknown[],
	scope: { projectId: string; organizationId: string | null },
): boolean {
	// 1) Path gate: queryKey[0] is the oRPC procedure path. Require it to end with
	//    the full ["newsletter","sends","list"] segments so we don't match siblings
	//    (e.g. subscribers.list, settings.get) that carry the same input.
	const path = queryKey[0];
	if (!Array.isArray(path)) {
		return false;
	}
	const tail = path.slice(-3);
	const isSendsListPath =
		tail[0] === "newsletter" && tail[1] === "sends" && tail[2] === "list";
	if (!isSendsListPath) {
		return false;
	}

	// 2) Tenant gate: oRPC nests the procedure input somewhere in the key array.
	//    Scan for the object that carries projectId and compare only the
	//    tenant-scoping fields (paging/filter fields are deliberately ignored).
	const stack: unknown[] = [...queryKey];
	while (stack.length) {
		const part = stack.pop();
		if (Array.isArray(part)) {
			stack.push(...part);
			continue;
		}
		if (part && typeof part === "object") {
			const obj = part as Record<string, unknown>;
			const input = ("input" in obj ? obj.input : obj) as
				| Record<string, unknown>
				| undefined;
			if (input && typeof input === "object" && "projectId" in input) {
				return (
					input.projectId === scope.projectId &&
					(input.organizationId ?? null) === scope.organizationId
				);
			}
		}
	}
	return false;
}

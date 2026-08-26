import {
	describeChatProviderFailure,
	tableLookup,
} from "../../../lib/chat-provider-error";

/**
 * A publishing chat-delivery row's stored outcome → admin-facing copy
 * (Fizzy #1850, 1C-4b).
 *
 * Separate from newsletter's `describeChatDeliveryFailure` because the two
 * ledgers CLASSIFY differently, not because the copy differs. This table has
 * BOTH a `reason` and an `errorMessage` column and they are not
 * interchangeable: `reason` is a closed classification an operator can filter a
 * query on, `errorMessage` is whatever the provider said. The newsletter path
 * predates the split and puts its skip classification in `errorMessage`, which
 * is why the same string there is both a reason and an error. A mapper here
 * that consulted `errorMessage` on a SKIPPED row would be reading a column its
 * writer never sets.
 *
 * Total: every input returns a string or null, none throws.
 */

const SKIP_REASONS: Record<string, string> = {
	CHANNEL_NOT_LINKED:
		"This channel is no longer linked to the project. Re-link it in project settings to resume delivery.",
	LINKER_NOT_AUTHORIZED:
		"The account that linked this channel no longer has access to the project. Re-link the channel to resume delivery.",
};

/**
 * `reason` is a bare `String?` with no Prisma enum and no CHECK, and
 * `markPublishingChatDelivery` accepts it independently of `status` — a DB test
 * already writes SKIPPED with none. So the fallback is not defensive theatre:
 * `PublishingChatDeliveryReason` is a TypeScript-only constraint that a future
 * writer can widen without anything stopping it.
 */
const GENERIC_SKIP = "This channel was skipped for this refresh.";

/**
 * Deliberately NOT newsletter's wording, in both halves.
 *
 * Not "most likely posted": the claim is written BEFORE the provider is
 * contacted (broadcast-topics-to-chat.ts:524-532, provider at :569/:593), and
 * the activity's own comment at :182-188 says so — "the claim is taken BEFORE
 * the provider is contacted, so it does not establish that anything reached the
 * room." The path that strands these rows in bulk is a heartbeat kill in which
 * nothing was posted at all, so the newsletter prior is inverted precisely in
 * the case that generates them.
 *
 * Not "before resending": there is no resend. The claim refuses any channel that
 * already holds a row, so a stranded channel is unpostable for this cycle by
 * design. Offering an action the product does not have is worse than offering
 * none.
 */
const UNCONFIRMED =
	"Delivery was started but never confirmed — it may or may not have reached the channel. This channel is not retried for this refresh; check the channel before posting manually.";

/**
 * A row is SENDING for the WHOLE duration of the provider call, not only when
 * it has been stranded — and the cycle is already terminal and listed in the
 * history table before the broadcast is even dispatched. So the operator most
 * likely to open this panel, the one who just clicked "Generate now", would be
 * shown `UNCONFIRMED` for a delivery still in flight and told to post manually.
 * If they did, the message lands twice in a shared room, which is the exact
 * outcome the fail-closed claim exists to prevent.
 *
 * The bound is the broadcast activity's own worst case with room to spare: a
 * 2-minute start-to-close over 3 attempts, plus backoff. Erring long is the
 * right direction — describing a stranded row as still running costs a later
 * refresh, describing a running row as stranded costs a duplicate post.
 */
const IN_FLIGHT_MS = 10 * 60 * 1000;

const IN_FLIGHT =
	"Delivery is in progress — this refresh is still broadcasting to the channel.";

export function describePublishingChatDelivery(
	status: string,
	reason: string | null | undefined,
	errorMessage: string | null | undefined,
	platform: string,
	createdAt?: Date | null,
	now: number = Date.now(),
): string | null {
	if (status === "SENT") {
		return null;
	}
	if (status === "SENDING") {
		const age = createdAt
			? now - createdAt.getTime()
			: Number.POSITIVE_INFINITY;
		return age < IN_FLIGHT_MS ? IN_FLIGHT : UNCONFIRMED;
	}
	if (status === "SKIPPED") {
		return tableLookup(SKIP_REASONS, (reason ?? "").trim()) ?? GENERIC_SKIP;
	}
	if (status === "FAILED") {
		return describeChatProviderFailure(errorMessage, platform);
	}
	// `status` has no Prisma enum — it is constrained by
	// publishing_chat_delivery_status_check alone, so a value the CHECK admits is
	// a value the type system will not stop.
	return describeChatProviderFailure(null, platform);
}

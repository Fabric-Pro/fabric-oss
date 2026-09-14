import { ORPCError } from "@orpc/server";
import {
	FUNCTION_TAG_VALUES,
	getProjectMemberFunctionTags,
	hasProjectAccess,
	isFeatureEnabled,
	isOrganizationMember,
	membersHoldingTags,
	usersWhoCanCreateOrganizationApiKeys,
} from "@repo/database";
import { z } from "zod";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { gatherReadinessEvidence } from "../../lib/readiness/evidence";

/**
 * How many people one ask may reach (Fizzy #2457).
 *
 * The same 50 the bulk-operations standard sets and `share-story` uses, applied
 * to the ELIGIBLE recipient list — what survives tag expansion, the union with
 * the named ids, the self-skip and the can-mint-a-key filter — rather than only
 * to the request, because a single function tag on a large project can name far
 * more people than any hand-typed array would. What is bounded is the number of
 * notification rows one request can write, which is the thing worth bounding,
 * so the count that matters is the one taken immediately before the fan-out.
 *
 * Over the cap the whole call fails rather than truncating. A silent truncation
 * would return a count that is technically true and practically a lie — the
 * asker would believe the Developers group had been asked when a slice of it
 * had. The refusal carries `TOO_MANY_RECIPIENTS` and both numbers, because a
 * caller who could not know a tag's size before sending cannot be told to "try
 * again" and left to guess what would be different next time.
 */
const MAX_RECIPIENTS = 50;

/**
 * Machine-readable discriminator on the over-cap refusal (Fizzy #2457).
 *
 * The client collapses an unrecognised server message into one generic retry
 * string, which for this refusal is actively false: retrying an ask that
 * resolved to 60 people fails identically forever. Named here so the client can
 * match on it rather than on prose.
 */
const TOO_MANY_RECIPIENTS_CODE = "TOO_MANY_RECIPIENTS";

/**
 * Machine-readable discriminator on the originator refusal (Fizzy #2457).
 *
 * See the "who may originate" note on the procedure. Distinct from a plain
 * project-access refusal: the caller does reach the project, and telling them
 * otherwise would be a lie they could not act on.
 */
const ORG_MEMBERSHIP_REQUIRED_CODE = "ORGANIZATION_MEMBERSHIP_REQUIRED";

const RequestCliConnectionInput = z
	.object({
		projectId: z.string(),
		/**
		 * Accepted for shape-consistency with the rest of the readiness
		 * namespace and ignored. Every organization this handler uses — for the
		 * rows it writes, for the roster it trusts and for the permission it
		 * tests — is the project's own, resolved server-side. Pairing a project
		 * the caller may read with an organization they may not is how a
		 * cross-tenant write gets in.
		 */
		organizationId: z.string().nullable().optional(),
		/** Teammates named one by one in the picker. */
		userIds: z.array(z.string()).max(MAX_RECIPIENTS).default([]),
		/**
		 * Function tags to expand into their holders ON THIS PROJECT. Capped at
		 * the number of tags that exist, which makes a repeated-tag flood
		 * impossible without a second read.
		 */
		functionTags: z
			.array(z.enum(FUNCTION_TAG_VALUES))
			.max(FUNCTION_TAG_VALUES.length)
			.default([]),
	})
	.refine(
		(value) => value.userIds.length > 0 || value.functionTags.length > 0,
		{ message: "Name at least one teammate or one function tag." },
	);

const RequestCliConnectionOutput = z.object({
	/**
	 * Notification rows ACTUALLY written. Excludes the asker, anyone dropped
	 * for being unable to create a key, anyone still holding an unread ask for
	 * this project, anyone who has silenced the category, and any write that
	 * failed — the last of which `failedCount` below reports separately, so a
	 * short count is never left ambiguous. The panel may say "asked N people"
	 * only because this number is what happened rather than what was attempted.
	 */
	notifiedCount: z.number().int().nonnegative(),
	/**
	 * People this ask resolved to and tried to reach — after tag expansion, the
	 * union, the self-skip and the eligibility filter, before delivery.
	 *
	 * Here because the caller cannot compute it: naming a tag, they do not know
	 * how many people it holds on this project until the server says so. Group
	 * mentions ask for confirmation above ten recipients and this is the number
	 * that comparison needs; enforcing that threshold is the UI's business, not
	 * this handler's.
	 */
	recipientCount: z.number().int().nonnegative(),
	/**
	 * Roster members who were named or tagged and cannot mint an API key, so
	 * were never written to. Separated from the plain difference between the
	 * two counts above because "three of them can't create a key" and "three of
	 * them already have this sitting unread" are different things to tell
	 * somebody, and a single delta cannot distinguish them.
	 */
	ineligibleCount: z.number().int().nonnegative(),
	/**
	 * Recipients whose notification row could not be written — the database
	 * refused, or the write threw for any other reason. The fan-out swallows
	 * these so one bad row cannot fail the asker's whole request; this is what
	 * stops them from being swallowed all the way to the client too.
	 *
	 * Here because without it the caller cannot tell an ask that was declined
	 * from an ask that broke. `recipientCount - notifiedCount` alone folds
	 * "already had one unread" and "the write failed" into one number, and the
	 * only sentence the client can then write covers the dedupe case — which
	 * for a failed write tells the asker their colleague was already asked when
	 * nobody asked them at all.
	 *
	 * The three buckets are exhaustive and disjoint at this boundary:
	 * `recipientCount = notifiedCount + failedCount + (deliberately skipped)`,
	 * so a caller wanting the skipped count subtracts rather than being handed
	 * a fourth number that could disagree with the other three.
	 */
	failedCount: z.number().int().nonnegative(),
});

/**
 * Ask teammates to connect a coding CLI to Fabric (Fizzy #2457).
 *
 * The CLI-connection prompt reports that nothing in the organization is reaching
 * Fabric over MCP. This is the other half of that prompt: the viewer
 * can pass the job to the people who would actually do it, either by naming
 * them or by naming a function tag — say Developer — and reaching everyone on
 * the project who carries it.
 *
 * ## It does NOT re-check `organizationCliConnected`, deliberately
 *
 * An adversarial review proposed refusing the ask when the organization is
 * already connected, on the grounds that the notification would otherwise carry
 * a stale organization-wide negative. The negative was the problem, and it was
 * removed: the row this writes names who asked, about which project, and what
 * it takes — no claim about the organization, so there is nothing left to go
 * stale between the render and the recipient opening it days later.
 *
 * With the claim gone the gate has nothing to protect. The ask itself stays
 * legitimate either way: a colleague having connected does not set up anybody
 * else's tooling, and a recipient who already has theirs working simply
 * dismisses a row. Refusing on that state would cost a second readiness gather
 * on the send path in order to turn a harmless request into an error.
 *
 * ## Authorization: PROJECT_READ, and why so little
 *
 * Asking a colleague for a favour changes nothing. No project state moves, no
 * setting is written, nothing is granted; the only effect is a notification row
 * the recipient may ignore. `share-story` reaches the same conclusion for the
 * same reason and gates its fan-out on a READ-level project permission, so a
 * viewer who spots a gap can pull in the person who can close it. Requiring
 * edit rights here would mean the people most likely to notice that the team's
 * tooling is unconnected — and least able to fix it themselves — are the ones
 * who cannot ask.
 *
 * What the low gate does NOT do is let the caller choose an audience. Every
 * recipient is intersected with the project roster server-side, and the whole
 * call fails on an outsider rather than quietly dropping them: a request naming
 * somebody off the roster is not a partially valid request, it is a client that
 * has been tampered with or has drifted, and answering it with a success and a
 * smaller number teaches nobody anything.
 *
 * ## Who may ORIGINATE: an organization member, which PROJECT_READ is not
 *
 * `PROJECT_READ` is the right gate for the audience and the wrong one for the
 * sender. An accepted `ProjectMember` row is authoritative on its own, so a
 * guest invited to one project — carrying no membership of its host
 * organization — clears `PROJECT_READ` and would otherwise be able to push a
 * string they control into up to fifty organization members' inboxes, and out
 * through `dispatchExternalDelivery` into their email as a SUBJECT LINE. Their
 * display name is theirs to edit (`USER_UPDATE_SELF` sits in every role's set),
 * which turns an unauthenticated-feeling phishing line into something the
 * product sends on the attacker's behalf. That is an outbound-messaging
 * capability, and it does not belong to somebody standing outside the tenant
 * they would be messaging.
 *
 * So the bar is membership of the project's organization, checked live. Not
 * "can mint a key", although today every named role can and the two agree:
 *
 *   - Membership is the property the risk is actually about — the sender should
 *     be inside the tenant whose inboxes they reach. Tying the right to ask to
 *     `ORG_API_KEYS_CREATE` would instead tie it to a permission that has
 *     already moved twice (Fizzy #2380, then again for #2457), so a future
 *     matrix edit would silently delete the ability to ask.
 *   - It would also invert the reason this procedure has a READ-level gate at
 *     all: the person worth hearing from is precisely the one who cannot do the
 *     job themselves. Requiring them to be able to mint the key before they may
 *     ask somebody else to mint it is the "get promoted first" trap in a
 *     smaller box.
 *
 * This removes no access from a guest. They keep the project, the readiness
 * panel, the CLI-connection row and their own ability to connect a tool; what
 * they lose is the ability to make the product email other people.
 *
 * ## Tags are project-scoped
 *
 * A function tag is held on a project, not on an organization — there is no
 * org-wide tag query and this must not invent one. `getProjectMemberFunctionTags`
 * returns the current roster left-joined onto its tag rows, so expansion cannot
 * name a former member, and it doubles as the allow-list the explicit ids are
 * checked against: one read answers both questions.
 *
 * Unlike the comment surface's group mention this does not route through
 * `expandGroupMentionsByTag`. That helper is flag-gated and fail-open by design
 * — a group mention must never break the comment it rides on, so it degrades to
 * nobody. Here the fan-out IS the request: silently succeeding with an empty
 * recipient list would tell the asker their team had been asked when it had
 * not, so a failure to read the roster must surface as a failure.
 *
 * ## No audit row
 *
 * Deliberate, and checked rather than assumed: the closed taxonomy in
 * `AUDIT_ACTIONS` has no fitting action, and nothing here is a
 * security-relevant mutation. No permission changes, no credential is created
 * or read, nothing leaves the deployment. The neighbouring dismissal records
 * the same conclusion. Inventing a key for it would grow a closed set for an
 * event no forensic review asks about.
 */
export const requestCliConnectionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/readiness/request-cli-connection",
		tags: ["Projects", "Readiness"],
		summary: "Ask teammates to connect a coding CLI",
		description:
			"Notifies named project members, and the holders of the named function tags on this project, that the caller would like them to connect a coding tool to Fabric. The notification names the asker and the project and asserts nothing about the organization's connection state, which this procedure does not re-read. Recipients who cannot create an API key are skipped.",
	})
	.input(RequestCliConnectionInput)
	.output(RequestCliConnectionOutput)
	.handler(async ({ input, context }) => {
		if (!(await isFeatureEnabled("PROJECT_READINESS"))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project readiness is not enabled.",
			});
		}

		const gathered = await gatherReadinessEvidence(input.projectId);
		if (!gathered) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found." });
		}

		const { tenant, project, cliNudgeEnabled } = gathered;

		// Both gates, unlike the dismissal beside this one. A decline stays a
		// decline however the rollout moves afterwards, so that write does not
		// consult the rollout gate — but this one sends messages to other
		// people, and an organization the rollout has not reached should not be
		// able to. The gathered answer is reused rather than looked up again so
		// the two halves of one request cannot disagree.
		if (!cliNudgeEnabled) {
			throw new ORPCError("NOT_FOUND", {
				message: "The CLI connection prompt is not enabled.",
			});
		}

		const organizationId = tenant.organizationId;
		if (!organizationId) {
			// Fail closed, exactly as the dismissal does. Every account has an
			// organization; a project without one means a tenant failed to
			// resolve upstream, and the eligibility test below would answer
			// nobody anyway.
			throw new ORPCError("NOT_FOUND", {
				message: "This project has no organization.",
			});
		}

		// Independent of the permission middleware on purpose. The middleware
		// resolves what the caller may do; this asserts they still reach the
		// project at all, from the project's own tenancy rather than from
		// anything in the request. `share-story` carries the same re-check
		// before its fan-out.
		if (!(await hasProjectAccess(input.projectId, context.user.id))) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// The originator bar, and the only check here that `PROJECT_READ` does
		// not already imply — see "Who may ORIGINATE" above. A project guest
		// clears every gate before this one and must not be able to put a
		// string of their own choosing into organization members' inboxes and
		// email subject lines. Asked before any audience is resolved, so a
		// refused caller learns nothing about the roster.
		if (!(await isOrganizationMember(context.user.id, organizationId))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only members of this project's organization can ask teammates to connect a coding tool.",
				data: { code: ORG_MEMBERSHIP_REQUIRED_CODE },
			});
		}

		// One read, two jobs: the allow-list every explicit id is checked
		// against, and the roster the tags expand within. Creator plus accepted,
		// unexpired members — the set the member picker shows.
		const roster = await getProjectMemberFunctionTags(input.projectId);
		const onRoster = new Set(roster.map((entry) => entry.userId));

		const requestedIds = Array.from(new Set(input.userIds));
		const outsiders = requestedIds.filter((id) => !onRoster.has(id));
		if (outsiders.length > 0) {
			// The whole call, not the offending ids. A caller that can name one
			// person outside the roster has already established it is not the
			// picker, and a partial success would hide that.
			throw new ORPCError("BAD_REQUEST", {
				message:
					"One or more recipients are not members of this project",
			});
		}

		// Tags resolve through the roster, so a tag holder who has left the
		// project cannot be reached by naming their tag.
		const taggedIds = membersHoldingTags(roster, input.functionTags);

		// Union of both routes, de-duplicated: naming someone AND their tag
		// asks them once. The actor is dropped here as well as inside the
		// fan-out — asking yourself is not an error, it is just nothing.
		const resolvedIds = Array.from(
			new Set([...requestedIds, ...taggedIds]),
		).filter((id) => id !== context.user.id);

		// Who among them could actually act on the ask. The prompt exists
		// because no live credential in the organization is reaching Fabric,
		// and the way to change that is to mint an API key, so somebody who
		// cannot mint one has been handed a task they cannot perform; they are
		// dropped before the write rather than notified and left to work that
		// out.
		//
		// The named question in `@repo/database` rather than a local copy of
		// it: that module holds the organization-role questions the permission
		// middleware cannot be mounted for, and its docstring asks callers not
		// to carry a permission constant across the package boundary. Its
		// batch form is one indexed `IN (...)` read for the whole list.
		const canConnect = await usersWhoCanCreateOrganizationApiKeys(
			organizationId,
			resolvedIds,
		);
		const recipientIds = resolvedIds.filter((id) => canConnect.has(id));
		const ineligibleCount = resolvedIds.length - recipientIds.length;

		if (recipientIds.length > MAX_RECIPIENTS) {
			// Distinguishable on purpose. "Try again" is false here — the same
			// tag resolves to the same crowd forever — and the caller could not
			// have known the crowd's size before sending, so the refusal
			// carries both numbers and a code the client can match on to say
			// something true instead.
			throw new ORPCError("BAD_REQUEST", {
				message: `This ask reaches ${recipientIds.length} people, and one ask may reach at most ${MAX_RECIPIENTS}. Name fewer people, or a narrower function tag.`,
				data: {
					code: TOO_MANY_RECIPIENTS_CODE,
					recipientCount: recipientIds.length,
					maxRecipients: MAX_RECIPIENTS,
				},
			});
		}

		if (recipientIds.length === 0) {
			// Nothing to send and nothing wrong: every named person was the
			// asker, or nobody named can mint a key. The counts say which.
			return {
				notifiedCount: 0,
				recipientCount: 0,
				ineligibleCount,
				failedCount: 0,
			};
		}

		const { notified, failed } = await fanOut.cliConnectionRequested({
			recipientUserIds: recipientIds,
			projectId: input.projectId,
			projectName: project.name,
			// The project's organization, never the caller's input — this is
			// the tenant the notification rows belong to.
			organizationId,
			actorUserId: context.user.id,
			actorName: context.user.name ?? "Someone",
			// Context-relative: `resolveNotificationLink` re-bases it onto the
			// recipient's own workspace, and the prompt they need lives on the
			// project page.
			link: `projects/${input.projectId}`,
		});

		return {
			notifiedCount: notified,
			recipientCount: recipientIds.length,
			ineligibleCount,
			failedCount: failed,
		};
	});

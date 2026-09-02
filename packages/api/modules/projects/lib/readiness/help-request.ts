/**
 * Composing a readiness help request (Fizzy #2165, FR22).
 *
 * "Request help" used to send the mail itself and then tell the user the
 * support inbox had been notified. Two things were wrong with that. The
 * message carried only fields, so nobody could say what was actually stuck;
 * and it arrived from a no-reply sender, so the answer had nowhere to go.
 *
 * The 2 September direction is that the button should open the user's own mail
 * client with everything filled in, and let them add the sentence that makes
 * the request answerable. Fabric composes, the person sends. That also means
 * Fabric never claims a delivery it cannot observe — once the draft is open,
 * what happens next is between the user and their mail client.
 *
 * It has a useful side effect for anyone running Fabric outside our
 * deployment: composing a draft needs no mail provider, no sending domain and
 * no credentials, so "Request help" works on a self-hosted install that has
 * configured nothing at all beyond the address itself.
 *
 * The address still comes from `SUPPORT_EMAIL` and is never a literal here: it
 * is published with the source, and the inbox that should answer differs
 * between deployments.
 */

import { config } from "@repo/config";
import { db } from "@repo/database";
import { getMessagesForLocale } from "@repo/i18n";
import { toAbsoluteUrl } from "@repo/utils";
import { READINESS_RULES_BY_KEY } from "./registry";

export type ReadinessHelpRequest = {
	projectId: string;
	itemKey: string;
	requesterName: string;
	requesterEmail: string;
	requestedAt: Date;
};

/**
 * Practical ceiling for the whole `mailto:` URL.
 *
 * There is no limit in RFC 6068 itself, but mail clients and the OS handlers
 * that pass the URL along impose their own, and the failure mode is silent
 * truncation rather than an error. 1800 leaves room under the ~2000 that the
 * strictest handlers accept, and the context block below is far shorter than
 * that unless a project or organization has been given an essay for a name —
 * which is what `clamp` is for.
 */
const MAILTO_MAX_LENGTH = 1800;

/**
 * Keep one field from eating the whole budget.
 *
 * Applied per value rather than to the assembled body so that a runaway
 * project name cannot push the requester's own address out of the message —
 * losing the reply address would defeat the point of the change.
 */
function clamp(value: string, max = 120): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * The checklist item's own name, in the default locale.
 *
 * Deliberately not the requester's locale: the reader is a shared support
 * inbox, so the item should arrive named the way the people triaging it know
 * it. Resolved here rather than in a template because a `readiness.items.*`
 * key that failed to resolve would otherwise render as literal text.
 */
async function resolveItemName(itemKey: string): Promise<string> {
	const rule = READINESS_RULES_BY_KEY.get(itemKey);
	if (!rule) {
		return itemKey;
	}
	const messages = await getMessagesForLocale(config.i18n.defaultLocale);
	const name = `${rule.i18nKey}.name`
		.split(".")
		.reduce<unknown>(
			(node, segment) =>
				node && typeof node === "object"
					? (node as Record<string, unknown>)[segment]
					: undefined,
			messages,
		);
	return typeof name === "string" ? name : itemKey;
}

/**
 * Where the project lives, for the link in the message.
 *
 * Mirrors the panel's own construction: `/app/{slug}/projects/{id}` inside an
 * organization, `/app/projects/{id}` when the slug cannot be resolved, so a
 * missing slug still lands the reader on a page that can show the project.
 */
function projectPath(projectId: string, organizationSlug: string | null) {
	return organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
}

/**
 * Build the `mailto:` URL for one help request.
 *
 * Returns `null` when no support address is configured or the project cannot
 * be read — the caller records the request either way and simply has no draft
 * to open, which is the honest outcome rather than a broken link.
 *
 * The body opens with blank lines on purpose: the user's cursor lands above
 * the context block, so the first thing they do is describe the problem rather
 * than scroll past machine-generated text.
 */
export async function buildReadinessHelpMailto(
	request: ReadinessHelpRequest,
): Promise<string | null> {
	const supportEmail = config.support.email;
	if (!supportEmail) {
		return null;
	}

	const project = await db.project.findUnique({
		where: { id: request.projectId },
		select: {
			name: true,
			organization: { select: { name: true, slug: true } },
		},
	});
	if (!project) {
		return null;
	}

	const itemName = await resolveItemName(request.itemKey);
	const projectUrl = toAbsoluteUrl(
		projectPath(request.projectId, project.organization?.slug ?? null),
	);

	const subject = `Help with "${clamp(itemName)}" in ${clamp(project.name)}`;

	// `\r\n` rather than `\n`: RFC 6068 wants CRLF in a mailto body, and
	// `encodeURIComponent` turns it into the %0D%0A that clients expect.
	const context = [
		"— — —",
		"Sent from the Fabric project readiness checklist.",
		"",
		`Checklist item: ${clamp(itemName)}`,
		`Project:        ${clamp(project.name)}`,
		`Organization:   ${clamp(project.organization?.name ?? "—")}`,
		`Requested by:   ${clamp(request.requesterName)} <${request.requesterEmail}>`,
		`Requested at:   ${request.requestedAt.toISOString()}`,
		// Stands in for the "TF Hosted / Self Hosted" the spec asks for:
		// the deployment the request came from is the same signal and needs
		// no separate flag to be kept accurate.
		`Deployment:     ${projectUrl}`,
	].join("\r\n");

	const body = `\r\n\r\n${context}`;

	const url = `mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

	// A draft that opens truncated is worse than one without the context
	// block, because the user cannot tell which half went missing.
	return url.length > MAILTO_MAX_LENGTH
		? `mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent(subject)}`
		: url;
}

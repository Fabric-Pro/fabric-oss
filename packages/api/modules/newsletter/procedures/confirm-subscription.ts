import { confirmPublicSubscriberByToken } from "@repo/database";
import { sendEmail } from "@repo/mail";
import { z } from "zod";
import { localeMiddleware } from "../../../orpc/middleware/locale-middleware";
import { rateLimitedPublicProcedure } from "../../../orpc/procedures";
import { runInBackground } from "../../weave/lib/run-in-background";
import { captureConfirmedNewsletterLead } from "../lib/gtm-lead";

export const confirmSubscriptionProcedure = rateLimitedPublicProcedure
	.route({
		method: "POST",
		path: "/newsletter/confirm",
		tags: ["Newsletter"],
		summary: "Confirm a pending newsletter subscription (double opt-in)",
	})
	.input(z.object({ token: z.string().min(10) }))
	.use(localeMiddleware)
	.handler(async ({ input, context }) => {
		// Resolve purely by token (per-project): the helper owns the per-project
		// lookup AND the revocation gate (widget enabled + version match for
		// embed-stamped rows; null-stamp legacy/marketing rows bypass the gate).
		// No FABRIC_MAIN_PROJECT_ID lock — the unguessable token is the bearer
		// credential and identifies the project.
		const { confirmed, email, projectId } =
			await confirmPublicSubscriberByToken(input.token);

		// Welcome email ONLY on a real activation (count === 1 in the helper), so a
		// replayed/gated/unknown token never re-mails.
		if (confirmed && email) {
			runInBackground(
				sendEmail({
					to: email,
					locale: context.locale,
					templateId: "newsletterSignup",
					context: {},
				}),
			);

			// GTM Brain only receives the COMPANY newsletter (Fabric-main). We gate on
			// the project the gated confirm actually resolved — never by re-confirming
			// the token through an ungated project-scoped lookup, which would bypass
			// the widget-enabled / token-version revocation gate above.
			const fabricMainProjectId =
				process.env.FABRIC_MAIN_PROJECT_ID?.trim();
			if (fabricMainProjectId && projectId === fabricMainProjectId) {
				runInBackground(captureConfirmedNewsletterLead({ email }));
			}
		}

		return { confirmed };
	});

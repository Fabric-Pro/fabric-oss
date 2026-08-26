import {
	createPendingPublicSubscriber,
	db,
	resolveProjectByEmbedToken,
	upsertEmbedPendingSubscriber,
} from "@repo/database";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";
import { localeMiddleware } from "../../../orpc/middleware/locale-middleware";
import { rateLimitedPublicProcedure } from "../../../orpc/procedures";
import { runInBackground } from "../../weave/lib/run-in-background";

export const subscribeToNewsletter = rateLimitedPublicProcedure
	.route({
		method: "POST",
		path: "/newsletter",
		tags: ["Newsletter"],
		summary: "Subscribe to the release-notes newsletter (double opt-in)",
	})
	.input(
		z.object({
			email: z.string().trim().email(),
			// Opaque per-project embed token. Present → subscribe to THAT project's
			// newsletter (per-project double opt-in). Absent → the env-locked
			// Fabric-main marketing path below, unchanged.
			token: z.string().optional(),
		}),
	)
	.use(localeMiddleware)
	.handler(async ({ input, context }) => {
		// Normalize in the handler (not only in the Zod schema): canonical storage
		// for @@unique([projectId,email]) and case/whitespace de-dup.
		const email = input.email.trim().toLowerCase();

		// Embed-widget path: a token resolves the target project explicitly. This is
		// the ONLY tenant bound on this BYPASSRLS public procedure — we filter by the
		// resolved projectId, never via an RLS context.
		//
		// Body response is uniform `{ success: true }` across every embed branch (no
		// existence oracle). We deliberately do NOT equalize per-branch LATENCY: the
		// subscribe write is awaited for reliability, and the embed token is public by
		// design (it ships in the iframe snippet on the embedder's own page), so a
		// timing difference between "valid token" and "invalid token" reveals nothing
		// secret. The 3 req/min IP rate limit bounds probing regardless.
		if (input.token) {
			const proj = await resolveProjectByEmbedToken(input.token);
			if (!proj || !proj.publicWidgetEnabled) {
				return { success: true };
			}
			// Audit actor: the settings creator (folded into the token resolve above),
			// falling back to the project owner — mirrors how the Fabric-main path
			// below resolves createdByUserId. NewsletterSettings.createdByUserId is
			// non-nullable, but legacy/sentinel rows + a null owner can still leave it
			// unresolvable, so guard + log (M-1) rather than silently dropping.
			const createdByUserId = proj.createdByUserId ?? proj.userId;
			if (!createdByUserId) {
				logger.warn("Public newsletter subscribe discarded", {
					event: "newsletter_public_subscribe_discarded",
					reason: "no audit actor (embed)",
				});
				return { success: true };
			}
			const { token, sendEmail: doSend } =
				await upsertEmbedPendingSubscriber({
					projectId: proj.projectId,
					email,
					// XOR tenant columns from the resolved project.
					userId: proj.organizationId ? null : proj.userId,
					organizationId: proj.organizationId ?? null,
					createdByUserId,
					version: proj.publicEmbedTokenVersion,
				});
			if (doSend && token) {
				const confirmUrl = `${getBaseUrl()}/newsletter/confirm/${token}`;
				runInBackground(
					sendEmail({
						to: email,
						locale: context.locale,
						templateId: "newsletterConfirm",
						context: { confirmUrl },
					}),
				);
			}
			return { success: true };
		}

		const projectId = process.env.FABRIC_MAIN_PROJECT_ID?.trim();

		// Every branch returns the SAME generic result — no body or timing tells
		// reveal subscriber existence. The confirm email is dispatched off the
		// request path (runInBackground), so new vs. existing is not distinguishable
		// by latency either.
		if (!projectId) {
			logger.warn("Public newsletter subscribe discarded", {
				event: "newsletter_public_subscribe_discarded",
				reason: "FABRIC_MAIN_PROJECT_ID unset",
			});
			return { success: true };
		}

		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			logger.warn("Public newsletter subscribe discarded", {
				event: "newsletter_public_subscribe_discarded",
				reason: "Fabric-main project not found",
			});
			return { success: true };
		}

		const settings = await db.newsletterSettings.findUnique({
			where: { projectId },
			select: { createdByUserId: true },
		});
		const createdByUserId = settings?.createdByUserId ?? project.userId;
		if (!createdByUserId) {
			logger.warn("Public newsletter subscribe discarded", {
				event: "newsletter_public_subscribe_discarded",
				reason: "no audit actor",
			});
			return { success: true };
		}

		const result = await createPendingPublicSubscriber({
			projectId,
			email,
			userId: project.organizationId ? null : project.userId,
			organizationId: project.organizationId ?? null,
			createdByUserId,
		});

		if (result.created && result.token) {
			const confirmUrl = `${getBaseUrl()}/newsletter/confirm/${result.token}`;
			runInBackground(
				sendEmail({
					to: email,
					locale: context.locale,
					templateId: "newsletterConfirm",
					context: { confirmUrl },
				}),
			);
		}

		return { success: true };
	});

/**
 * Review a pull request for ONE named project, authenticated by that project's
 * own secret.
 *
 * This exists because the shared endpoint cannot answer the question it needs to
 * answer. `POST /api/webhooks/github/pull-request` verifies one deployment-wide
 * `GITHUB_WEBHOOK_SECRET`, and the setup instructions give that secret to every
 * customer admin who connects a repository. A signed delivery therefore proves
 * only that SOMEBODY with the deployment secret sent it — not which tenant it
 * belongs to — while the repository URL it names is attacker-chosen. The shared
 * handler resolved that URL to every project that had ever connected it, in any
 * tenant, and started a run in each.
 *
 * Addressing the delivery to a project removes the question rather than
 * answering it:
 *
 *  - **The project is in the URL**, so nothing is resolved from attacker-chosen
 *    content. A delivery cannot reach a project it was not sent to.
 *  - **The secret is the project's own**, from `ProjectQaWebhook` — the same
 *    per-project secret, rotation window and expiry the CI-results webhook
 *    already uses, rather than a second mechanism to keep in step.
 *  - **The repository still has to match.** A valid secret for project A cannot
 *    review a repository A never connected.
 *
 * Everything else matches the shared endpoint deliberately: the same actions,
 * the same draft rule, always 200 to the sender unless the signature itself is
 * wrong, and the work scheduled after the response.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
	findAllByRepoUrl,
	getProjectQaSettings,
	getProjectQaWebhookConfiguration,
} from "@repo/database";
import { logger } from "@repo/logs";
import { decryptApiKey } from "@repo/utils";
import { runInBackground } from "../../../weave/lib/run-in-background";
import { runAutomaticPrReview } from "../../lib/pr-review-run";
import {
	type PullRequestWebhookResult,
	REVIEWED_ACTIONS,
	repositoryUrlCandidates,
} from "./github-pull-request-webhook";

/**
 * Constant-time HMAC check against every secret currently valid for the project
 * — the live one, plus the previous one while its rotation window is open.
 */
function verifies(
	signatureHeader: string,
	rawBody: string,
	secrets: readonly string[],
): boolean {
	const normalized = signatureHeader.replace(/^sha256=/i, "").trim();
	if (!/^[a-f0-9]{64}$/i.test(normalized)) {
		return false;
	}
	const provided = Buffer.from(normalized, "hex");
	return secrets.some((secret) => {
		const expected = createHmac("sha256", secret).update(rawBody).digest();
		return timingSafeEqual(provided, expected);
	});
}

type PullRequestEvent = {
	action?: string;
	number?: number;
	pull_request?: { number?: number; draft?: boolean };
	repository?: { clone_url?: string; html_url?: string };
};

export async function handleProjectPullRequestWebhook(params: {
	projectId: string;
	signatureHeader: string;
	eventName: string;
	rawBody: string;
	payload: unknown;
}): Promise<PullRequestWebhookResult> {
	const config = await getProjectQaWebhookConfiguration(params.projectId);
	if (!config) {
		// No secret configured for this project. Answering 401 rather than 200:
		// unlike an unknown repository on the shared endpoint, somebody chose
		// this URL deliberately and it will never work until they finish the
		// setup, so silence would hide a misconfiguration indefinitely.
		return {
			status: 401,
			handled: false,
			reason: "webhook-not-configured",
		};
	}

	const now = new Date();
	// Decryption can throw — an encryption key that was rotated without its
	// predecessor being kept has already broken a stored credential in this
	// codebase once. Letting it escape turns every delivery into a 500, which is
	// the retried-then-throttled-then-disabled outcome this whole path is built
	// to avoid, and it would read as a Fabric outage rather than as the key
	// misconfiguration it is.
	let secrets: string[];
	try {
		secrets = [decryptApiKey(config.encryptedSecret)];
		if (
			config.previousEncryptedSecret &&
			config.previousSecretRetiresAt &&
			config.previousSecretRetiresAt > now
		) {
			secrets.push(decryptApiKey(config.previousEncryptedSecret));
		}
	} catch (error) {
		logger.error(
			"[pr-review-webhook] could not decrypt the project's webhook secret",
			{
				projectId: params.projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return { status: 401, handled: false, reason: "secret-undecryptable" };
	}
	if (!verifies(params.signatureHeader, params.rawBody, secrets)) {
		return { status: 401, handled: false, reason: "invalid-signature" };
	}
	if (config.expiresAt && config.expiresAt <= now) {
		return { status: 401, handled: false, reason: "secret-expired" };
	}

	if (params.eventName !== "pull_request") {
		return {
			status: 200,
			handled: false,
			reason: "not-a-pull-request-event",
		};
	}

	const event = params.payload as PullRequestEvent;
	if (!event.action || !REVIEWED_ACTIONS.has(event.action)) {
		return { status: 200, handled: false, reason: "action-not-reviewed" };
	}
	if (event.pull_request?.draft) {
		return { status: 200, handled: false, reason: "draft" };
	}

	const prNumber = event.pull_request?.number ?? event.number;
	if (!prNumber) {
		return {
			status: 400,
			handled: false,
			reason: "no-pull-request-number",
		};
	}

	const candidates = repositoryUrlCandidates(event.repository);
	if (candidates.length === 0) {
		return { status: 400, handled: false, reason: "no-repository-url" };
	}

	// The repository must be one THIS project connected. A valid secret is
	// permission to review this project's own pull requests, not permission to
	// name any repository in the deployment.
	let integration:
		| Awaited<ReturnType<typeof findAllByRepoUrl>>[number]
		| undefined;
	try {
		const integrations = await findAllByRepoUrl(candidates);
		integration = integrations.find(
			(i) => i.projectId === params.projectId,
		);
	} catch (error) {
		logger.error("[pr-review-webhook] could not resolve the delivery", {
			projectId: params.projectId,
			prNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: 200, handled: false, reason: "lookup-failed" };
	}
	if (!integration) {
		return {
			status: 200,
			handled: false,
			reason: "repository-not-connected",
		};
	}
	// Bound to a const so the narrowing survives into the closure below.
	const connected = integration;

	let settings: Awaited<ReturnType<typeof getProjectQaSettings>>;
	try {
		settings = await getProjectQaSettings(params.projectId);
	} catch (error) {
		logger.warn("[pr-review-webhook] could not read a project's settings", {
			projectId: params.projectId,
			prNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: 200, handled: false, reason: "lookup-failed" };
	}
	if (!settings.prReviewAutoReviewEnabled) {
		return { status: 200, handled: false, reason: "auto-review-off" };
	}

	runInBackground(
		runAutomaticPrReview({
			projectId: connected.projectId,
			repositoryIntegrationId: connected.id,
			prNumber,
			actingUserId: connected.configuredByUserId,
			organizationId: connected.project.organizationId,
		}).then((outcome) => {
			logger.info("[pr-review-webhook] automatic review finished", {
				projectId: connected.projectId,
				prNumber,
				...outcome,
			});
		}),
	);

	return { status: 200, handled: true, projects: 1 };
}

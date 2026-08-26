/**
 * GitHub Push Webhook Handler (oRPC Procedure)
 *
 * Receives GitHub push events and triggers code reindexing for connected projects.
 * This is a publicProcedure (no auth) — verification is via HMAC-SHA256 signature.
 *
 * Features:
 * - Verifies X-Hub-Signature-256 header using GITHUB_WEBHOOK_SECRET
 * - Extracts tenant context from ProjectRepositoryIntegration record
 * - Marks ProjectCodeIndex as STALE
 * - Starts codeIndexingWorkflow with incremental: true when FEATURE_CODE_INDEXING=true
 *
 * Tenant Isolation (CRITICAL — no user session in webhooks):
 * - Extract repository URL from push payload
 * - Lookup ProjectRepositoryIntegration by repo URL
 * - Use the integration's project.userId and project.organizationId as tenant context
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	createBackgroundJob,
	findByRepoUrl,
	getProjectCodeIndex,
	markCodeIndexStale,
	parseRepoUrl,
	seedSteps,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import { publicProcedure } from "../../../../orpc/procedures";
import { codeIndexWorkflowId } from "../../lib/code-indexing-trigger";

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

/**
 * Verify GitHub webhook signature using HMAC-SHA256
 *
 * GitHub sends: X-Hub-Signature-256: sha256=<hex_hash>
 * We compute HMAC-SHA256(secret, rawBody) and compare.
 */
/**
 * Local to this module again. It was exported so the SHARED pull-request webhook
 * could verify signatures the same way; that endpoint is retired, and the
 * per-project one verifies against a project's own secret rather than the
 * deployment's, so it needs its own multi-secret check for the rotation window.
 */
function verifyGitHubSignature(
	secret: string,
	signatureHeader: string,
	rawBody: string,
): boolean {
	if (!secret || !signatureHeader || !rawBody) {
		return false;
	}

	// GitHub format: sha256=<hex>
	const expectedPrefix = "sha256=";
	if (!signatureHeader.startsWith(expectedPrefix)) {
		return false;
	}

	const receivedSig = signatureHeader.slice(expectedPrefix.length);

	const hmac = createHmac("sha256", secret);
	hmac.update(rawBody);
	const computedSig = hmac.digest("hex");

	try {
		const recvBuffer = Buffer.from(receivedSig);
		const compBuffer = Buffer.from(computedSig);

		if (recvBuffer.length !== compBuffer.length) {
			return false;
		}

		return timingSafeEqual(recvBuffer, compBuffer);
	} catch {
		return false;
	}
}

/**
 * Extract changed files from GitHub push payload commits array
 */
function extractChangedFiles(
	commits: Array<{
		added?: string[];
		removed?: string[];
		modified?: string[];
	}>,
): string[] {
	const changed = new Set<string>();
	for (const commit of commits) {
		for (const file of commit.added ?? []) {
			changed.add(file);
		}
		for (const file of commit.removed ?? []) {
			changed.add(file);
		}
		for (const file of commit.modified ?? []) {
			changed.add(file);
		}
	}
	return Array.from(changed);
}

/**
 * Core webhook handler logic — shared between oRPC procedure and Next.js route
 */
export async function handleGitHubPushWebhook(params: {
	signatureHeader: string;
	rawBody: string;
	payload: unknown;
}): Promise<{
	status: number;
	message: string;
	projectId?: string;
	workflowId?: string;
	action?: string;
}> {
	const { signatureHeader, rawBody, payload } = params;

	// Verify signature
	if (!GITHUB_WEBHOOK_SECRET) {
		console.error(
			"[GitHub Push Webhook] GITHUB_WEBHOOK_SECRET not configured",
		);
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Webhook secret not configured",
		});
	}

	const isValid = verifyGitHubSignature(
		GITHUB_WEBHOOK_SECRET,
		signatureHeader,
		rawBody,
	);

	if (!isValid) {
		throw new ORPCError("UNAUTHORIZED", { message: "Invalid signature" });
	}

	// Validate payload shape
	const pushPayload = payload as {
		repository?: {
			clone_url?: string;
			html_url?: string;
		};
		commits?: Array<{
			added?: string[];
			removed?: string[];
			modified?: string[];
		}>;
		ref?: string;
	};

	// Prefer html_url (matches how the integration is stored). Fall back to
	// clone_url with the trailing `.git` stripped so older payloads still
	// resolve. GitHub stores the integration without the `.git` suffix during
	// OAuth (`https://github.com/owner/repo`), so a raw clone_url match misses.
	const rawRepoUrl =
		pushPayload.repository?.html_url ||
		pushPayload.repository?.clone_url?.replace(/\.git$/, "");

	if (!rawRepoUrl) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Missing repository URL in payload",
		});
	}

	// Find integration by repo URL — this is our ONLY source of tenant context
	const integration = await findByRepoUrl(rawRepoUrl);

	if (!integration) {
		// Silently ignore — not our repo
		return {
			status: 200,
			message: "No integration found for this repository",
			action: "ignored",
		};
	}

	const projectId = integration.projectId;
	const userId = integration.project.userId;
	const organizationId = integration.project.organizationId;

	console.log("[GitHub Push Webhook] Processing push:", {
		rawRepoUrl,
		projectId,
		userId,
		organizationId: organizationId ?? "personal",
	});

	// The index is per-repo and tracks the integration's default branch. A push
	// to any other branch doesn't affect that index, so ignore it.
	const indexBranch = integration.defaultBranch || "main";
	const pushedBranch = pushPayload.ref?.replace("refs/heads/", "");
	if (pushedBranch && pushedBranch !== indexBranch) {
		return {
			status: 200,
			message: `Ignored push to non-indexed branch ${pushedBranch}`,
			projectId,
			action: "ignored_branch",
		};
	}

	// Find this repo's code index row
	const codeIndex = await getProjectCodeIndex(
		projectId,
		integration.id,
		indexBranch,
	);

	if (!codeIndex) {
		// Repo hasn't set up indexing yet — do nothing
		return {
			status: 200,
			message: "No code index exists for this repository",
			projectId,
			action: "no_index",
		};
	}

	// Mark this repo's index as STALE
	await markCodeIndexStale(projectId, integration.id);
	console.log("[GitHub Push Webhook] Marked code index as STALE:", {
		projectId,
		integrationId: integration.id,
	});

	// Start incremental reindex if feature is enabled
	if (process.env.FEATURE_CODE_INDEXING === "true") {
		const parsed = parseRepoUrl(rawRepoUrl);
		const repoName = parsed
			? `${parsed.owner}/${parsed.name}`
			: integration.repositoryName;

		const changedFiles = extractChangedFiles(pushPayload.commits ?? []);

		const branch = indexBranch;

		const client = await getTemporalClient();
		// Stable per-repo id + TERMINATE_EXISTING so a push supersedes any
		// in-flight run for this repo instead of racing it (shared with the
		// interactive trigger).
		const workflowId = codeIndexWorkflowId(projectId, integration.id);

		const handle = await client.workflow.start(
			"codeIndexingWorkflow" as any,
			withCorrelationMemo({
				taskQueue: "code-indexing",
				workflowId,
				workflowIdConflictPolicy: "TERMINATE_EXISTING",
				args: [
					{
						projectId,
						userId,
						organizationId: organizationId ?? undefined,
						repositoryUrl: rawRepoUrl,
						branch,
						integrationId: integration.id,
						provider: integration.provider as
							| "GITHUB"
							| "AZURE_DEVOPS"
							| "GITLAB",
						repoName,
						incremental: true,
						changedFiles,
					},
				],
				workflowExecutionTimeout: "12h", // large monorepos: full symbol+embed+summary grind can exceed 2h; continueAsNew keeps per-run history bounded
			}),
		);

		// Job Hub: a push-triggered re-index is background work nobody asked for
		// interactively, which is exactly when visible progress matters — the
		// row explains why the repo is busy. Created after the start because the
		// workflow id is stable and started with TERMINATE_EXISTING: opening the
		// row first would expose it to the superseded run's still-executing
		// activities.
		await createBackgroundJob({
			kind: "CODE_INDEXING",
			title: repoName,
			projectId,
			userId,
			organizationId: organizationId ?? null,
			workflowId,
			runId: handle?.firstExecutionRunId ?? null,
			sourceType: "repositoryIntegration",
			sourceId: integration.id,
			steps: seedSteps([
				"clone",
				"secretScan",
				"walk",
				"symbols",
				"embed",
				"summaries",
				"finalize",
			]),
		});

		console.log(
			"[GitHub Push Webhook] Started incremental code indexing workflow:",
			{ projectId, workflowId, changedFilesCount: changedFiles.length },
		);

		return {
			status: 200,
			message: "Marked as STALE and started incremental reindex",
			projectId,
			workflowId,
			action: "stale_and_reindex",
		};
	}

	return {
		status: 200,
		message: "Marked as STALE (FEATURE_CODE_INDEXING is disabled)",
		projectId,
		action: "stale_only",
	};
}

/**
 * oRPC publicProcedure for GitHub push webhook
 *
 * Can be called directly at /api/projects/code-indexing/github-webhook
 * or used as the backing logic for the Next.js route handler.
 *
 * NOTE: When called directly, the raw body must be provided in the
 * x-raw-body header and the signature in x-hub-signature-256 header
 * since oRPC parses JSON bodies automatically.
 */
export const githubPushWebhookProcedure = publicProcedure
	.route({
		method: "POST",
		path: "/projects/code-indexing/github-webhook",
		tags: ["Projects", "Code Indexing", "Webhooks"],
		summary: "GitHub push webhook for auto-reindex",
		description:
			"Receives GitHub push events and triggers incremental code reindexing. " +
			"When called via oRPC, provide raw body in x-raw-body header and signature in x-hub-signature-256 header.",
	})
	.input(
		z.object({
			// oRPC will parse JSON body; we read headers for HMAC verification
		}),
	)
	.handler(async ({ context }) => {
		const signatureHeader =
			context.headers.get("x-hub-signature-256") || "";
		const rawBody = context.headers.get("x-raw-body") || "";

		if (!rawBody) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"x-raw-body header required (oRPC parses JSON body automatically)",
			});
		}

		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid JSON body",
			});
		}

		const result = await handleGitHubPushWebhook({
			signatureHeader,
			rawBody,
			payload,
		});

		return result;
	});

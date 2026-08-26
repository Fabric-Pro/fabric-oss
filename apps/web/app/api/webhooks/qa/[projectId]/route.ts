import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import {
	claimProjectQaWebhookDelivery,
	completeProjectQaWebhookDelivery,
	getProjectQaWatchedBranches,
	getProjectQaWebhookConfiguration,
	ingestPipelineRun,
	recordProjectQaWebhookError,
	releaseProjectQaWebhookDelivery,
} from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { NextResponse } from "next/server";
import { z } from "zod";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const githubPayloadSchema = z.object({
	workflow_run: z.object({
		id: z.number(),
		name: z.string().nullish(),
		head_branch: z.string().nullish(),
		head_sha: z.string().nullish(),
		html_url: z.string().nullish(),
		status: z.string().nullish(),
		conclusion: z.string().nullish(),
		run_started_at: z.string().nullish(),
		updated_at: z.string(),
		triggering_actor: z
			.object({
				login: z.string().nullish(),
				avatar_url: z.string().nullish(),
			})
			.nullish(),
	}),
});

const gitlabPayloadSchema = z.object({
	object_kind: z.literal("pipeline"),
	object_attributes: z.object({
		id: z.number(),
		status: z.string().nullish(),
		ref: z.string().nullish(),
		sha: z.string().nullish(),
		url: z.string().nullish(),
		created_at: z.string().nullish(),
		finished_at: z.string().nullish(),
		duration: z.number().nullish(),
	}),
	user: z
		.object({
			name: z.string().nullish(),
			username: z.string().nullish(),
			avatar_url: z.string().nullish(),
		})
		.nullish(),
});

const adoPayloadSchema = z.object({
	eventType: z.literal("build.complete"),
	createdDate: z.string(),
	resource: z.object({
		id: z.number(),
		buildNumber: z.string().nullish(),
		status: z.string().nullish(),
		result: z.string().nullish(),
		sourceBranch: z.string().nullish(),
		sourceVersion: z.string().nullish(),
		startTime: z.string().nullish(),
		finishTime: z.string().nullish(),
		requestedFor: z.object({ displayName: z.string().nullish() }).nullish(),
		_links: z
			.object({
				web: z.object({ href: z.string().nullish() }).nullish(),
			})
			.nullish(),
	}),
});

type PreparedDelivery = {
	provider: string;
	deliveryId: string;
	timestamp: Date;
	run: Omit<Parameters<typeof ingestPipelineRun>[0]["run"], "provider">;
};

type SignatureEnvelope = {
	signature: string;
	payload: string;
};

function acceptedResponse() {
	return NextResponse.json({ accepted: true });
}

function getRateLimitKey(request: Request, projectId: string): string {
	const trustedHeader = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase();
	let client = "unknown";
	if (trustedHeader === "cf-connecting-ip") {
		client = request.headers.get("cf-connecting-ip") ?? client;
	} else if (trustedHeader === "x-real-ip") {
		client = request.headers.get("x-real-ip") ?? client;
	} else if (trustedHeader === "x-forwarded-for") {
		client =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			client;
	}
	if (client === "unknown") {
		client = createHash("sha256")
			.update(
				`${request.headers.get("user-agent") ?? ""}\0${request.headers.get("accept-language") ?? ""}`,
			)
			.digest("hex")
			.slice(0, 16);
	}
	return `qa-webhook:${projectId}:${client}`;
}

function getSignatureEnvelope(
	request: Request,
	rawBody: string,
): SignatureEnvelope | null {
	if (request.headers.get("x-github-event") === "workflow_run") {
		const signature = request.headers.get("x-hub-signature-256");
		return signature ? { signature, payload: rawBody } : null;
	}

	const provider = request.headers.get("x-fabric-qa-provider");
	const deliveryId = request.headers.get("x-fabric-qa-delivery");
	const timestamp = request.headers.get("x-fabric-qa-timestamp");
	const signature = request.headers.get("x-fabric-qa-signature");
	if (!provider || !deliveryId || !timestamp || !signature) {
		return null;
	}
	return {
		signature,
		payload: `${provider}.${deliveryId}.${timestamp}.${rawBody}`,
	};
}

/**
 * A branch name comparable across providers.
 *
 * Azure DevOps reports `refs/heads/main` where GitHub and GitLab report `main`,
 * and the branch a project watches is stored short. Comparing the raw strings
 * matches nothing for Azure DevOps, which would silently drop every one of its
 * runs — a filter that discards everything looks identical to a provider that
 * sends nothing.
 */
function shortBranchName(value: string): string {
	return value.replace(/^refs\/heads\//, "").trim();
}

function dateOrNull(value: string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function httpUrlOrNull(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function prepareDelivery(
	request: Request,
	payload: unknown,
): PreparedDelivery | null {
	const githubEvent = request.headers.get("x-github-event");
	if (githubEvent === "workflow_run") {
		const parsed = githubPayloadSchema.safeParse(payload);
		const deliveryId = request.headers.get("x-github-delivery");
		if (!parsed.success || !deliveryId) {
			return null;
		}
		const run = parsed.data.workflow_run;
		const timestamp = dateOrNull(run.updated_at);
		if (!timestamp) {
			return null;
		}
		const startedAt = dateOrNull(run.run_started_at);
		const finishedAt =
			run.status === "completed" ? dateOrNull(run.updated_at) : null;
		return {
			provider: "github-actions",
			deliveryId,
			timestamp,
			run: {
				externalRunId: String(run.id),
				pipelineName: run.name ?? null,
				branch: run.head_branch ?? null,
				commitSha: run.head_sha ?? null,
				runUrl: httpUrlOrNull(run.html_url),
				status: run.conclusion ?? run.status ?? null,
				startedAt,
				finishedAt,
				durationMs:
					startedAt && finishedAt
						? Math.max(
								0,
								finishedAt.getTime() - startedAt.getTime(),
							)
						: null,
				triggeredByActor: run.triggering_actor?.login ?? null,
				triggeredByActorAvatarUrl: httpUrlOrNull(
					run.triggering_actor?.avatar_url,
				),
				totalCount: 0,
				passedCount: 0,
				failedCount: 0,
				skippedCount: 0,
				otherCount: 0,
			},
		};
	}

	const provider = request.headers.get("x-fabric-qa-provider");
	const deliveryId = request.headers.get("x-fabric-qa-delivery");
	const timestampHeader = request.headers.get("x-fabric-qa-timestamp");
	if (!provider || !deliveryId || !timestampHeader) {
		return null;
	}
	const timestamp = new Date(Number(timestampHeader) * 1000);
	if (Number.isNaN(timestamp.getTime())) {
		return null;
	}
	if (provider === "gitlab") {
		const parsed = gitlabPayloadSchema.safeParse(payload);
		if (!parsed.success) {
			return null;
		}
		const pipeline = parsed.data.object_attributes;
		return {
			provider: "gitlab-ci",
			deliveryId,
			timestamp,
			run: {
				externalRunId: String(pipeline.id),
				pipelineName: null,
				branch: pipeline.ref ?? null,
				commitSha: pipeline.sha ?? null,
				runUrl: httpUrlOrNull(pipeline.url),
				status: pipeline.status ?? null,
				startedAt: dateOrNull(pipeline.created_at),
				finishedAt: dateOrNull(pipeline.finished_at),
				durationMs:
					pipeline.duration == null
						? null
						: Math.max(0, Math.round(pipeline.duration * 1000)),
				triggeredByActor:
					parsed.data.user?.name ??
					parsed.data.user?.username ??
					null,
				triggeredByActorAvatarUrl: httpUrlOrNull(
					parsed.data.user?.avatar_url,
				),
				totalCount: 0,
				passedCount: 0,
				failedCount: 0,
				skippedCount: 0,
				otherCount: 0,
			},
		};
	}

	if (provider === "azure-devops") {
		const parsed = adoPayloadSchema.safeParse(payload);
		if (!parsed.success) {
			return null;
		}
		const build = parsed.data.resource;
		const startedAt = dateOrNull(build.startTime);
		const finishedAt = dateOrNull(build.finishTime);
		return {
			provider: "azure-devops",
			deliveryId,
			timestamp,
			run: {
				externalRunId: String(build.id),
				pipelineName: build.buildNumber ?? null,
				branch: build.sourceBranch ?? null,
				commitSha: build.sourceVersion ?? null,
				runUrl: httpUrlOrNull(build._links?.web?.href),
				status: build.result ?? build.status ?? null,
				startedAt,
				finishedAt,
				durationMs:
					startedAt && finishedAt
						? Math.max(
								0,
								finishedAt.getTime() - startedAt.getTime(),
							)
						: null,
				triggeredByActor: build.requestedFor?.displayName ?? null,
				triggeredByActorAvatarUrl: null,
				totalCount: 0,
				passedCount: 0,
				failedCount: 0,
				skippedCount: 0,
				otherCount: 0,
			},
		};
	}

	return null;
}

function verifies(
	signature: string,
	payload: string,
	secrets: readonly string[],
): boolean {
	const normalized = signature.replace(/^sha256=/i, "");
	if (!/^[a-f0-9]{64}$/i.test(normalized)) {
		return false;
	}
	const provided = Buffer.from(normalized, "hex");
	return secrets.some((secret) => {
		const expected = createHmac("sha256", secret).update(payload).digest();
		return timingSafeEqual(provided, expected);
	});
}

async function readBody(request: Request): Promise<string | null> {
	if (!request.body) {
		return "";
	}
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let body = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return body + decoder.decode();
			}
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			body += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

export async function POST(
	request: Request,
	context: { params: Promise<{ projectId: string }> },
) {
	const { projectId } = await context.params;
	const { limit, windowMs } = RATE_LIMIT_PRESETS.webhook;
	const rateLimit = await checkRateLimit(
		getRateLimitKey(request, projectId),
		limit,
		windowMs,
	);
	if (!rateLimit.allowed) {
		return NextResponse.json(
			{ accepted: false },
			{
				status: rateLimit.statusCode ?? 429,
				headers: {
					"Retry-After": String(rateLimit.resetInSeconds),
				},
			},
		);
	}

	const config = await getProjectQaWebhookConfiguration(projectId);
	if (!config) {
		return acceptedResponse();
	}
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > MAX_BODY_BYTES) {
		return NextResponse.json({ accepted: false }, { status: 413 });
	}
	const rawBody = await readBody(request);
	if (rawBody === null) {
		return NextResponse.json({ accepted: false }, { status: 413 });
	}
	const envelope = getSignatureEnvelope(request, rawBody);
	if (!envelope) {
		return acceptedResponse();
	}
	const now = new Date();
	const secrets = [decryptApiKey(config.encryptedSecret)];
	if (
		config.previousEncryptedSecret &&
		config.previousSecretRetiresAt &&
		config.previousSecretRetiresAt > now
	) {
		secrets.push(decryptApiKey(config.previousEncryptedSecret));
	}
	if (!verifies(envelope.signature, envelope.payload, secrets)) {
		return acceptedResponse();
	}
	if (config.expiresAt && config.expiresAt <= now) {
		return NextResponse.json(
			{ accepted: false, error: "Webhook secret has expired." },
			{ status: 401 },
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return NextResponse.json({ accepted: false }, { status: 400 });
	}
	const delivery = prepareDelivery(request, payload);
	if (!delivery) {
		return NextResponse.json({ accepted: false }, { status: 400 });
	}
	if (
		Math.abs(now.getTime() - delivery.timestamp.getTime()) >
		MAX_CLOCK_SKEW_MS
	) {
		return NextResponse.json({ accepted: false }, { status: 401 });
	}

	// Apply the branch filter the sweep gets for free.
	//
	// The scheduled sweep asks the provider only for runs on the watched branch.
	// A webhook cannot ask for anything: GitHub sends every `workflow_run` in the
	// repository, so a repo with feature branches, preview deploys and dependabot
	// would fill the pipeline list with runs the sweep deliberately excluded —
	// and break the rule the whole ingestion design rests on, that a webhook can
	// never produce a result the sweep would not.
	//
	// Answered 200 rather than 4xx: the delivery was valid and correctly
	// verified, it simply is not for a branch this project watches. A non-2xx
	// here would have GitHub retry it and eventually disable the hook for
	// failing — punishing the customer for a filter that is working.
	const deliveredBranch = delivery.run.branch;
	const watchedBranches = await getProjectQaWatchedBranches(config.projectId);
	if (
		deliveredBranch &&
		watchedBranches.length > 0 &&
		!watchedBranches.some(
			(watched) =>
				shortBranchName(watched) === shortBranchName(deliveredBranch),
		)
	) {
		return NextResponse.json({ accepted: true, ignored: "branch" });
	}

	const claim = {
		webhookId: config.id,
		provider: delivery.provider,
		deliveryId: delivery.deliveryId,
		bodyDigest: createHash("sha256").update(rawBody).digest("hex"),
	};
	if (!(await claimProjectQaWebhookDelivery(claim))) {
		return NextResponse.json({ accepted: true, duplicate: true });
	}

	try {
		await ingestPipelineRun({
			projectId: config.projectId,
			organizationId: config.organizationId,
			userId: config.userId,
			run: {
				provider: delivery.provider,
				...delivery.run,
			},
			matched: [],
			unmatchedCount: 0,
			results: [],
		});
		await completeProjectQaWebhookDelivery({
			webhookId: config.id,
			receivedAt: now,
		});
		return NextResponse.json({ accepted: true });
	} catch (error) {
		await recordProjectQaWebhookError({
			webhookId: config.id,
			occurredAt: new Date(),
			message: "Pipeline ingestion failed.",
		}).catch(() => undefined);
		await releaseProjectQaWebhookDelivery(claim);
		throw error;
	}
}

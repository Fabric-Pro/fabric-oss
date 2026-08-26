import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	getWatchedBranches: vi.fn(),
	claim: vi.fn(),
	complete: vi.fn(),
	release: vi.fn(),
	ingest: vi.fn(),
	recordError: vi.fn(),
	rateLimit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectQaWebhookConfiguration: mocks.getConfig,
	getProjectQaWatchedBranches: mocks.getWatchedBranches,
	claimProjectQaWebhookDelivery: mocks.claim,
	completeProjectQaWebhookDelivery: mocks.complete,
	releaseProjectQaWebhookDelivery: mocks.release,
	ingestPipelineRun: mocks.ingest,
	recordProjectQaWebhookError: mocks.recordError,
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => value.replace("enc:", ""),
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mocks.rateLimit,
	RATE_LIMIT_PRESETS: {
		webhook: { limit: 60, windowMs: 60_000 },
	},
}));

import { POST } from "../route";

const PROJECT_ID = "project-1";
const SECRET = "qa-webhook-secret";
const PREVIOUS_SECRET = "previous-qa-webhook-secret";

function config(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "hook-1",
		projectId: PROJECT_ID,
		organizationId: "org-1",
		userId: null,
		encryptedSecret: `enc:${SECRET}`,
		secretHint: "cret",
		previousEncryptedSecret: null,
		previousSecretRetiresAt: null,
		expiresAt: null,
		lastDeliveryAt: null,
		deliveryCount: 0,
		lastError: null,
		lastErrorAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function githubPayload(updatedAt = new Date().toISOString()) {
	return {
		action: "completed",
		workflow_run: {
			id: 42,
			name: "CI",
			head_branch: "main",
			head_sha: "abc123",
			html_url: "https://github.com/acme/app/actions/runs/42",
			status: "completed",
			conclusion: "success",
			run_started_at: updatedAt,
			updated_at: updatedAt,
			triggering_actor: {
				login: "alice",
				avatar_url: "https://avatars.example/alice",
			},
		},
	};
}

function requestFor(
	payload: unknown,
	options?: { signature?: string; deliveryId?: string },
) {
	const body = JSON.stringify(payload);
	const signature =
		options?.signature ??
		`sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
	return new Request(`https://fabric.test/api/webhooks/qa/${PROJECT_ID}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": "workflow_run",
			"x-github-delivery": options?.deliveryId ?? "delivery-1",
			"x-hub-signature-256": signature,
		},
		body,
	});
}

function genericRequest(
	provider: "gitlab" | "azure-devops",
	payload: unknown,
	options?: { deliveryId?: string; timestamp?: string },
) {
	const body = JSON.stringify(payload);
	const deliveryId = options?.deliveryId ?? "delivery-generic-1";
	const timestamp =
		options?.timestamp ?? String(Math.floor(Date.now() / 1000));
	const signed = `${provider}.${deliveryId}.${timestamp}.${body}`;
	const signature = createHmac("sha256", SECRET).update(signed).digest("hex");
	return new Request(`https://fabric.test/api/webhooks/qa/${PROJECT_ID}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-fabric-qa-provider": provider,
			"x-fabric-qa-delivery": deliveryId,
			"x-fabric-qa-timestamp": timestamp,
			"x-fabric-qa-signature": `sha256=${signature}`,
		},
		body,
	});
}

const context = { params: Promise.resolve({ projectId: PROJECT_ID }) };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getConfig.mockResolvedValue(config());
	// Matches `githubPayload`'s head_branch, so the default case is a run on a
	// branch this project actually watches.
	mocks.getWatchedBranches.mockResolvedValue(["main"]);
	mocks.claim.mockResolvedValue(true);
	mocks.recordError.mockResolvedValue(undefined);
	mocks.rateLimit.mockResolvedValue({
		allowed: true,
		remaining: 59,
		resetInSeconds: 60,
	});
	mocks.ingest.mockResolvedValue({
		pipelineRunId: "run-1",
		matched: 0,
		unmatched: 0,
		alreadyIngested: false,
	});
});

describe("POST /api/webhooks/qa/[projectId]", () => {
	it("silently accepts an unknown project webhook without parsing the body", async () => {
		mocks.getConfig.mockResolvedValue(null);

		const response = await POST(
			new Request("https://fabric.test", {
				method: "POST",
				body: "not-json",
			}),
			context,
		);

		expect(response.status).toBe(200);
		expect(mocks.ingest).not.toHaveBeenCalled();
	});

	it("verifies the raw body and derives the tenant from the secret record", async () => {
		const response = await POST(requestFor(githubPayload()), context);

		expect(response.status).toBe(200);
		expect(mocks.ingest).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: "org-1",
				userId: null,
				run: expect.objectContaining({
					provider: "github-actions",
					externalRunId: "42",
				}),
			}),
		);
		expect(mocks.complete).toHaveBeenCalledWith(
			expect.objectContaining({ webhookId: "hook-1" }),
		);
	});

	it("silently accepts an invalid signature before claiming the delivery", async () => {
		const response = await POST(
			requestFor(githubPayload(), {
				signature: `sha256=${"0".repeat(64)}`,
			}),
			context,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.ingest).not.toHaveBeenCalled();
	});

	it("accepts the previous secret only during the rotation overlap", async () => {
		mocks.getConfig.mockResolvedValue(
			config({
				previousEncryptedSecret: `enc:${PREVIOUS_SECRET}`,
				previousSecretRetiresAt: new Date(Date.now() + 60_000),
			}),
		);
		const payload = githubPayload();
		const body = JSON.stringify(payload);
		const previousSignature = `sha256=${createHmac(
			"sha256",
			PREVIOUS_SECRET,
		)
			.update(body)
			.digest("hex")}`;

		const response = await POST(
			requestFor(payload, { signature: previousSignature }),
			context,
		);

		expect(response.status).toBe(200);
		expect(mocks.ingest).toHaveBeenCalledOnce();
	});

	it("rejects the previous secret after the rotation overlap", async () => {
		mocks.getConfig.mockResolvedValue(
			config({
				previousEncryptedSecret: `enc:${PREVIOUS_SECRET}`,
				previousSecretRetiresAt: new Date(Date.now() - 1),
			}),
		);
		const payload = githubPayload();
		const body = JSON.stringify(payload);
		const previousSignature = `sha256=${createHmac(
			"sha256",
			PREVIOUS_SECRET,
		)
			.update(body)
			.digest("hex")}`;

		const response = await POST(
			requestFor(payload, { signature: previousSignature }),
			context,
		);

		expect(response.status).toBe(200);
		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it("rejects a correctly signed delivery outside the replay window", async () => {
		const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
		const response = await POST(requestFor(githubPayload(old)), context);

		expect(response.status).toBe(401);
		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it("deduplicates a delivery before ingestion", async () => {
		mocks.claim.mockResolvedValue(false);

		const response = await POST(requestFor(githubPayload()), context);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ duplicate: true });
		expect(mocks.ingest).not.toHaveBeenCalled();
	});

	it("deduplicates a replay even when its unsigned GitHub delivery ID changes", async () => {
		mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const payload = githubPayload();

		await POST(requestFor(payload), context);
		const response = await POST(
			requestFor(payload, { deliveryId: "delivery-2" }),
			context,
		);

		expect(response.status).toBe(200);
		expect(mocks.claim).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				deliveryId: "delivery-2",
				bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		);
		expect(mocks.ingest).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"gitlab",
			{
				object_kind: "pipeline",
				object_attributes: {
					id: 81,
					status: "success",
					ref: "main",
					sha: "abc123",
					url: "https://gitlab.example/acme/app/-/pipelines/81",
					created_at: new Date().toISOString(),
					finished_at: new Date().toISOString(),
					duration: 4,
				},
				user: { username: "alice" },
			},
			"gitlab-ci",
			"81",
		],
		[
			"azure-devops",
			{
				eventType: "build.complete",
				createdDate: new Date().toISOString(),
				resource: {
					id: 91,
					buildNumber: "2026.91",
					status: "completed",
					result: "succeeded",
					sourceBranch: "refs/heads/main",
					sourceVersion: "def456",
				},
			},
			"azure-devops",
			"91",
		],
	] as const)(
		"verifies and ingests a signed %s delivery",
		async (provider, payload, expectedProvider, externalRunId) => {
			const response = await POST(
				genericRequest(provider, payload),
				context,
			);

			expect(response.status).toBe(200);
			expect(mocks.ingest).toHaveBeenCalledWith(
				expect.objectContaining({
					run: expect.objectContaining({
						provider: expectedProvider,
						externalRunId,
					}),
				}),
			);
		},
	);

	it("releases a delivery claim when ingestion fails so retry can proceed", async () => {
		mocks.ingest.mockRejectedValue(new Error("database unavailable"));

		await expect(
			POST(requestFor(githubPayload()), context),
		).rejects.toThrow("database unavailable");

		expect(mocks.release).toHaveBeenCalledWith({
			webhookId: "hook-1",
			provider: "github-actions",
			deliveryId: "delivery-1",
			bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(mocks.recordError).toHaveBeenCalledWith(
			expect.objectContaining({
				webhookId: "hook-1",
				message: "Pipeline ingestion failed.",
			}),
		);
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("refuses an expired configuration with an explicit message", async () => {
		mocks.getConfig.mockResolvedValue(
			config({ expiresAt: new Date(Date.now() - 1) }),
		);

		const response = await POST(requestFor(githubPayload()), context);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: "Webhook secret has expired.",
		});
	});

	it("rate limits before looking up the project secret", async () => {
		mocks.rateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 17,
		});

		const response = await POST(requestFor(githubPayload()), context);

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("17");
		expect(mocks.getConfig).not.toHaveBeenCalled();
	});
});

/**
 * The branch filter the sweep gets for free.
 *
 * The scheduled sweep asks the provider only for runs on the watched branch. A
 * webhook cannot ask for anything — GitHub sends every `workflow_run` in the
 * repository — so without this the endpoint ingests feature branches, preview
 * deploys and dependabot runs the sweep deliberately excluded, and breaks the
 * rule the ingestion design rests on: a webhook can never produce a result the
 * sweep would not.
 */
describe("branch filtering", () => {
	function payloadOnBranch(branch: string | null) {
		const payload = githubPayload();
		payload.workflow_run.head_branch = branch as string;
		return payload;
	}

	it("ingests a run on the watched branch", async () => {
		const response = await POST(requestFor(payloadOnBranch("main")), {
			params: Promise.resolve({ projectId: PROJECT_ID }),
		});

		expect(response.status).toBe(200);
		expect(mocks.ingest).toHaveBeenCalled();
	});

	it("ignores a run on any other branch", async () => {
		const response = await POST(
			requestFor(payloadOnBranch("feature/preview-deploy")),
			{ params: Promise.resolve({ projectId: PROJECT_ID }) },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ignored: "branch" });
		expect(mocks.ingest).not.toHaveBeenCalled();
	});

	it("does not claim the delivery for a branch it ignores", async () => {
		// Claiming would spend a delivery record and leave a dangling claim for a
		// payload that was never going to be ingested.
		await POST(requestFor(payloadOnBranch("dependabot/npm/lodash")), {
			params: Promise.resolve({ projectId: PROJECT_ID }),
		});

		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it("answers 200 rather than an error, so the provider does not retry or disable the hook", async () => {
		const response = await POST(requestFor(payloadOnBranch("wip")), {
			params: Promise.resolve({ projectId: PROJECT_ID }),
		});

		// A non-2xx would have GitHub retry, then disable the webhook for
		// failing — punishing the customer for a filter that is working.
		expect(response.status).toBe(200);
	});

	it("ingests when the project has no connected repository to judge against", async () => {
		// Cannot tell which branch matters, so it keeps the run rather than
		// newly dropping data on a project whose wiring it cannot see.
		mocks.getWatchedBranches.mockResolvedValue([]);

		await POST(requestFor(payloadOnBranch("anything")), {
			params: Promise.resolve({ projectId: PROJECT_ID }),
		});

		expect(mocks.ingest).toHaveBeenCalled();
	});

	it("ingests a run whose payload carries no branch", async () => {
		// Nothing to compare, so the filter abstains instead of guessing.
		await POST(requestFor(payloadOnBranch(null)), {
			params: Promise.resolve({ projectId: PROJECT_ID }),
		});

		expect(mocks.ingest).toHaveBeenCalled();
	});

	it("honours a per-repo QA branch that differs from the default", async () => {
		mocks.getWatchedBranches.mockResolvedValue(["release/2.0"]);

		await POST(requestFor(payloadOnBranch("release/2.0")), {
			params: Promise.resolve({ projectId: PROJECT_ID }),
		});

		expect(mocks.ingest).toHaveBeenCalled();
	});
});

/**
 * Azure DevOps reports `refs/heads/main` where GitHub and GitLab report `main`,
 * and the watched branch is stored short. An exact string comparison therefore
 * matches nothing for Azure DevOps and drops every one of its runs — which
 * looks exactly like a provider that is sending nothing at all.
 */
describe("branch filtering across provider ref formats", () => {
	function adoBuild(sourceBranch: string) {
		return {
			eventType: "build.complete",
			createdDate: new Date().toISOString(),
			resource: {
				id: 77,
				buildNumber: "2026.77",
				status: "completed",
				result: "succeeded",
				sourceBranch,
				sourceVersion: "def456",
				startTime: new Date().toISOString(),
				finishTime: new Date().toISOString(),
			},
		};
	}

	it("matches a fully-qualified Azure DevOps ref against a short watched branch", async () => {
		mocks.getWatchedBranches.mockResolvedValue(["main"]);

		await POST(
			genericRequest("azure-devops", adoBuild("refs/heads/main")),
			context,
		);

		expect(mocks.ingest).toHaveBeenCalled();
	});

	it("still ignores a fully-qualified ref for a branch nobody watches", async () => {
		mocks.getWatchedBranches.mockResolvedValue(["main"]);

		const response = await POST(
			genericRequest(
				"azure-devops",
				adoBuild("refs/heads/feature/spike"),
			),
			context,
		);

		expect(await response.json()).toMatchObject({ ignored: "branch" });
		expect(mocks.ingest).not.toHaveBeenCalled();
	});

	it("matches when the watched branch itself is stored fully qualified", async () => {
		mocks.getWatchedBranches.mockResolvedValue(["refs/heads/main"]);

		await POST(requestFor(githubPayload()), context);

		expect(mocks.ingest).toHaveBeenCalled();
	});
});

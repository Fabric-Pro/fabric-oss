/**
 * The PER-PROJECT pull-request webhook — the endpoint that fixes the tenancy
 * hole rather than merely bounding it.
 *
 * The shared endpoint verifies one deployment-wide `GITHUB_WEBHOOK_SECRET`, and
 * the setup docs hand that value to every customer admin who connects a
 * repository. A delivery signed with it therefore proves only that SOMEBODY with
 * the deployment secret sent it, while the repository URL inside is chosen by
 * whoever sent it. One signed delivery started review runs in six tenants.
 *
 * This endpoint removes the question instead of answering it: the project is in
 * the URL, and the secret is that project's own. So the tests are about exactly
 * that — a valid secret for project A must not be able to review anything but
 * project A's own connected repositories, and a failure must never be a 5xx that
 * teaches the sender to stop delivering.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findAllByRepoUrl,
	getProjectQaSettings,
	getProjectQaWebhookConfiguration,
	decryptApiKey,
	runAutomaticPrReview,
	runInBackground,
} = vi.hoisted(() => ({
	findAllByRepoUrl: vi.fn(),
	getProjectQaSettings: vi.fn(),
	getProjectQaWebhookConfiguration: vi.fn(),
	decryptApiKey: vi.fn(),
	runAutomaticPrReview: vi.fn(),
	runInBackground: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	findAllByRepoUrl: (...a: unknown[]) => findAllByRepoUrl(...a),
	getProjectQaSettings: (...a: unknown[]) => getProjectQaSettings(...a),
	getProjectQaWebhookConfiguration: (...a: unknown[]) =>
		getProjectQaWebhookConfiguration(...a),
}));
vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	decryptApiKey: (...a: unknown[]) => decryptApiKey(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Paths resolve from THIS file, not from the module under test.
vi.mock("../../../../weave/lib/run-in-background", () => ({
	runInBackground: (p: Promise<unknown>) => runInBackground(p),
}));
vi.mock("../../../lib/pr-review-run", () => ({
	runAutomaticPrReview: (...a: unknown[]) => runAutomaticPrReview(...a),
}));

const { handleProjectPullRequestWebhook } = await import(
	"../project-pull-request-webhook"
);

const LIVE_SECRET = "project-live-secret";
const PREVIOUS_SECRET = "project-previous-secret";
const PROJECT = "proj-1";

const sign = (body: string, secret: string) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function event(over: Record<string, unknown> = {}) {
	return JSON.stringify({
		action: "opened",
		pull_request: { number: 42, draft: false },
		repository: {
			clone_url: "https://github.com/example-org/example-repo.git",
			html_url: "https://github.com/example-org/example-repo",
		},
		...over,
	});
}

const INTEGRATION = {
	id: "integration-1",
	projectId: PROJECT,
	configuredByUserId: "user-1",
	project: { userId: "user-1", organizationId: "org-1" },
};

/** A delivery signed with whichever secret, defaulting to the live one. */
function call(body: string, secret: string = LIVE_SECRET, projectId = PROJECT) {
	return handleProjectPullRequestWebhook({
		projectId,
		signatureHeader: sign(body, secret),
		eventName: "pull_request",
		rawBody: body,
		payload: JSON.parse(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getProjectQaWebhookConfiguration.mockResolvedValue({
		encryptedSecret: "enc-live",
		previousEncryptedSecret: null,
		previousSecretRetiresAt: null,
		expiresAt: null,
	});
	decryptApiKey.mockImplementation((v: string) =>
		v === "enc-live" ? LIVE_SECRET : PREVIOUS_SECRET,
	);
	findAllByRepoUrl.mockResolvedValue([INTEGRATION]);
	getProjectQaSettings.mockResolvedValue({ prReviewAutoReviewEnabled: true });
	runAutomaticPrReview.mockResolvedValue({ ran: true });
	runInBackground.mockImplementation(() => undefined);
});

describe("handleProjectPullRequestWebhook — the happy path", () => {
	it("reviews exactly the project the delivery was addressed to", async () => {
		const result = await call(event());

		expect(result).toEqual({ status: 200, handled: true, projects: 1 });
		expect(runAutomaticPrReview).toHaveBeenCalledTimes(1);
		expect(runAutomaticPrReview).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				repositoryIntegrationId: "integration-1",
				prNumber: 42,
			}),
		);
	});

	it("asks for the secret of the project named in the URL", async () => {
		await call(event(), LIVE_SECRET, "proj-other");

		expect(getProjectQaWebhookConfiguration).toHaveBeenCalledWith(
			"proj-other",
		);
	});

	it("schedules the work rather than floating it", async () => {
		await call(event());

		expect(runInBackground).toHaveBeenCalledTimes(1);
	});
});

describe("handleProjectPullRequestWebhook — authentication", () => {
	it("refuses a delivery signed with the wrong secret", async () => {
		const body = event();

		const result = await call(body, "some-other-projects-secret");

		expect(result).toEqual({
			status: 401,
			handled: false,
			reason: "invalid-signature",
		});
		expect(runAutomaticPrReview).not.toHaveBeenCalled();
	});

	it("refuses when the project has no webhook configured", async () => {
		getProjectQaWebhookConfiguration.mockResolvedValue(null);

		const result = await call(event());

		expect(result).toEqual({
			status: 401,
			handled: false,
			reason: "webhook-not-configured",
		});
		expect(decryptApiKey).not.toHaveBeenCalled();
	});

	it("accepts the previous secret while its rotation window is open", async () => {
		getProjectQaWebhookConfiguration.mockResolvedValue({
			encryptedSecret: "enc-live",
			previousEncryptedSecret: "enc-previous",
			previousSecretRetiresAt: new Date(Date.now() + 60_000),
			expiresAt: null,
		});

		const result = await call(event(), PREVIOUS_SECRET);

		expect(result.handled).toBe(true);
	});

	it("refuses the previous secret once its window has closed", async () => {
		getProjectQaWebhookConfiguration.mockResolvedValue({
			encryptedSecret: "enc-live",
			previousEncryptedSecret: "enc-previous",
			previousSecretRetiresAt: new Date(Date.now() - 60_000),
			expiresAt: null,
		});

		const result = await call(event(), PREVIOUS_SECRET);

		expect(result.reason).toBe("invalid-signature");
		expect(runAutomaticPrReview).not.toHaveBeenCalled();
	});

	it("refuses an expired secret, and checks expiry only after the signature", async () => {
		// Order matters: an unauthenticated caller must not learn whether a
		// project's secret has expired.
		getProjectQaWebhookConfiguration.mockResolvedValue({
			encryptedSecret: "enc-live",
			previousEncryptedSecret: null,
			previousSecretRetiresAt: null,
			expiresAt: new Date(Date.now() - 1000),
		});

		expect((await call(event())).reason).toBe("secret-expired");
		expect((await call(event(), "wrong")).reason).toBe("invalid-signature");
	});

	it("answers 401 rather than 500 when the stored secret cannot be decrypted", async () => {
		// A rotated encryption key has broken a stored credential here before. An
		// escaping throw would make every delivery a 500, which is the
		// retried-then-throttled-then-disabled outcome this path exists to avoid.
		decryptApiKey.mockImplementation(() => {
			throw new Error("Encryption key version 2 not found");
		});

		const result = await call(event());

		expect(result).toEqual({
			status: 401,
			handled: false,
			reason: "secret-undecryptable",
		});
		expect(runAutomaticPrReview).not.toHaveBeenCalled();
	});

	it.each([
		["a malformed signature", "not-a-hex-digest"],
		["an empty signature", ""],
		["a truncated digest", "sha256=abc123"],
	])("rejects %s without throwing", async (_name, header) => {
		const body = event();

		const result = await handleProjectPullRequestWebhook({
			projectId: PROJECT,
			signatureHeader: header,
			eventName: "pull_request",
			rawBody: body,
			payload: JSON.parse(body),
		});

		expect(result.status).toBe(401);
		expect(result.reason).toBe("invalid-signature");
	});
});

describe("handleProjectPullRequestWebhook — what a valid secret does NOT buy", () => {
	it("refuses a repository this project has not connected", async () => {
		// The signature proves the sender holds project A's secret. It does not
		// make every repository in the deployment project A's business.
		findAllByRepoUrl.mockResolvedValue([
			{ ...INTEGRATION, projectId: "someone-elses-project" },
		]);

		const result = await call(event());

		expect(result).toEqual({
			status: 200,
			handled: false,
			reason: "repository-not-connected",
		});
		expect(runAutomaticPrReview).not.toHaveBeenCalled();
	});

	it("runs only THIS project when several tenants share the repository", async () => {
		findAllByRepoUrl.mockResolvedValue([
			{
				...INTEGRATION,
				id: "integration-other",
				projectId: "other-tenant-project",
				project: { userId: "user-2", organizationId: "org-2" },
			},
			INTEGRATION,
		]);

		const result = await call(event());

		expect(result).toEqual({ status: 200, handled: true, projects: 1 });
		expect(runAutomaticPrReview).toHaveBeenCalledTimes(1);
		expect(runAutomaticPrReview).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: PROJECT }),
		);
	});

	it("does nothing when the project has not opted into automatic review", async () => {
		getProjectQaSettings.mockResolvedValue({
			prReviewAutoReviewEnabled: false,
		});

		expect((await call(event())).reason).toBe("auto-review-off");
		expect(runAutomaticPrReview).not.toHaveBeenCalled();
	});
});

describe("handleProjectPullRequestWebhook — events it ignores", () => {
	it("reviews a draft the moment it is marked ready", async () => {
		const result = await call(
			event({
				action: "ready_for_review",
				pull_request: { number: 42, draft: false },
			}),
		);

		expect(result.handled).toBe(true);
	});

	it("leaves a draft alone", async () => {
		const result = await call(
			event({ pull_request: { number: 42, draft: true } }),
		);

		expect(result).toEqual({
			status: 200,
			handled: false,
			reason: "draft",
		});
	});

	it("ignores an action that changes no code", async () => {
		expect((await call(event({ action: "labeled" }))).reason).toBe(
			"action-not-reviewed",
		);
	});

	it("ignores an event type it does not review", async () => {
		const body = event();

		const result = await handleProjectPullRequestWebhook({
			projectId: PROJECT,
			signatureHeader: sign(body, LIVE_SECRET),
			eventName: "push",
			rawBody: body,
			payload: JSON.parse(body),
		});

		expect(result.reason).toBe("not-a-pull-request-event");
	});

	it("answers 200, not 5xx, when the lookup itself fails", async () => {
		findAllByRepoUrl.mockRejectedValue(new Error("database down"));

		const result = await call(event());

		expect(result).toEqual({
			status: 200,
			handled: false,
			reason: "lookup-failed",
		});
	});

	it("answers 200 when the settings read fails", async () => {
		getProjectQaSettings.mockRejectedValue(new Error("database down"));

		const result = await call(event());

		expect(result.status).toBe(200);
		expect(result.reason).toBe("lookup-failed");
		expect(runAutomaticPrReview).not.toHaveBeenCalled();
	});
});

/**
 * Behavioral (TestWorkflowEnvironment) coverage for automatic screenshots in
 * `generateAndSendNewsletterWorkflow`.
 *
 *  - A send that does not ask for screenshots runs none of the new
 *    activities, and curation gets no targeting: its command sequence is the
 *    one recorded before the patch.
 *  - With review on, the captures are created excluded and the send parks.
 *  - With review off, the captures are published and the delivered content
 *    carries them.
 *  - A capture that fails outright is recorded as failed and never fails the
 *    send.
 *  - At most two captures run at once, so the export queue keeps room for
 *    proposal exports.
 *
 * The capture activity runs on the export queue, so a second worker polls
 * `proposal-export` with only that activity.
 *
 * Mirrors `newsletter-approval-email.test.ts`: local time-skipping server, the
 * real bundled workflow code, mocked activities.
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROPOSAL_EXPORT_TASK_QUEUE } from "../../task-queues";
import type { GenerateAndSendNewsletterInput } from "../generate-and-send-newsletter";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "generateAndSendNewsletterWorkflow";

const BASE_INPUT: GenerateAndSendNewsletterInput = {
	sendId: "send-1",
	projectId: "proj-1",
	organizationId: "org-1",
	userId: null,
	triggeredByUserId: "user-1",
	projectName: "Example Project",
	trigger: "MANUAL",
	detailLevel: "STANDARD",
	requireApproval: true,
	captureScreenshots: true,
	timeWindowStart: "2026-11-01T00:00:00.000Z",
	timeWindowEnd: "2026-11-08T00:00:00.000Z",
};

const CURATED = {
	content: {
		schemaVersion: 1 as const,
		headline: "November update",
		intro: "Things shipped.",
		hasMajorFeatures: true,
		highlights: [
			{
				title: "Saved filters",
				description: "Filters can be saved.",
				visualChange: true,
				captureBrief: "The filters panel with one saved filter.",
			},
			{
				title: "Faster export",
				description: "Exports finish sooner.",
				visualChange: false,
			},
		],
	},
	aiUsageTokens: 10,
};

const PUBLISHED_IMAGE = {
	url: "https://app.example.com/image-proxy/bucket/newsletter-public/a.jpg",
	alt: "The filters panel",
};

interface RunOpts {
	input?: Partial<GenerateAndSendNewsletterInput>;
	/** Make the capture activity reject, as a lost worker would. */
	failCapture?: boolean;
	curated?: { content: unknown; aiUsageTokens: number };
	/** The rows the create activity returns; one row by default. */
	rows?: Array<{ id: string; highlightIndex: number }>;
}

interface RunCaptures {
	result: { status: string; sentCount: number };
	calls: string[];
	curateTargeting: unknown;
	createRows: Array<{ content: unknown; included: boolean }>;
	captureInputs: Array<{ imageId: string; highlight: { title: string } }>;
	/** Most captures that were running at the same moment. */
	maxCapturesInFlight: number;
	failedImages: Array<{ imageId: string; reason: string }>;
	heldContent: unknown;
	emailedContent: unknown;
}

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

let taskQueueSeq = 0;

async function runWorkflow(opts: RunOpts = {}): Promise<RunCaptures> {
	const captures: RunCaptures = {
		result: { status: "", sentCount: 0 },
		calls: [],
		curateTargeting: undefined,
		createRows: [],
		captureInputs: [],
		maxCapturesInFlight: 0,
		failedImages: [],
		heldContent: undefined,
		emailedContent: undefined,
	};
	const { calls } = captures;
	let capturesInFlight = 0;

	const activities = {
		collectGitHubReleasesActivity: async () => ({
			items: [
				{
					kind: "release",
					occurredAt: "2026-11-05T00:00:00.000Z",
					tagName: "v1.4.0",
					repoFullName: "example-org/example-repo",
					body: "Saved filters (#12)",
					url: "https://example.com/r/1",
				},
			],
			failures: [],
			activeRepoCount: 1,
		}),
		collectNewsletterTargetingActivity: async () => {
			calls.push("targeting");
			return {
				releases: [
					{
						repoFullName: "example-org/example-repo",
						tagName: "v1.4.0",
						changedPaths: ["apps/web/filters/Panel.tsx"],
						pathsTruncated: false,
						workItems: [],
					},
				],
			};
		},
		curateNewsletterFromReleasesActivity: async (args: {
			targeting?: unknown;
		}) => {
			calls.push("curate");
			captures.curateTargeting = args.targeting;
			return opts.curated ?? CURATED;
		},
		// The real activity picks the visible changes (screenshot-capture-rows
		// .test.ts); here the one visible highlight gets one row.
		createNewsletterCaptureRowsActivity: async (args: {
			content: unknown;
			included: boolean;
		}) => {
			calls.push("createRows");
			captures.createRows.push({
				content: args.content,
				included: args.included,
			});
			return opts.rows ?? [{ id: "img-1", highlightIndex: 0 }];
		},
		failNewsletterScreenshotCaptureActivity: async (args: {
			imageId: string;
			reason: string;
		}) => {
			calls.push("failCapture");
			captures.failedImages.push(args);
		},
		publishNewsletterScreenshotsActivity: async (args: {
			content: typeof CURATED.content;
		}) => {
			calls.push("publish");
			return {
				...args.content,
				highlights: args.content.highlights.map((h, i) =>
					i === 0 ? { ...h, images: [PUBLISHED_IMAGE] } : h,
				),
			};
		},
		holdNewsletterForApprovalActivity: async (args: {
			content: unknown;
		}) => {
			calls.push("hold");
			captures.heldContent = args.content;
		},
		sendNewsletterApprovalEmailsActivity: async () => {},
		sendNewsletterApprovalChatMessagesActivity: async () => {},
		loadActiveSubscribersActivity: async () => ({
			subscribers: [{ id: "sub-1", email: "jane.doe@example.com" }],
		}),
		sendNewsletterEmailsActivity: async (args: { content: unknown }) => {
			calls.push("email");
			captures.emailedContent = args.content;
			return { sentCount: 1, failedCount: 0 };
		},
		finalizeNewsletterSendActivity: async () => ({ finalized: true }),
	};

	const exportActivities = {
		captureNewsletterScreenshotActivity: async (args: {
			imageId: string;
			highlight: { title: string };
		}) => {
			calls.push("capture");
			captures.captureInputs.push(args);
			if (opts.failCapture) {
				throw new Error("worker lost");
			}
			capturesInFlight += 1;
			captures.maxCapturesInFlight = Math.max(
				captures.maxCapturesInFlight,
				capturesInFlight,
			);
			// Long enough for every capture the workflow started to overlap.
			await new Promise((done) => setTimeout(done, 200));
			capturesInFlight -= 1;
			return { ok: true };
		},
	};

	const taskQueue = `newsletter-auto-screenshots-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	const exportWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROPOSAL_EXPORT_TASK_QUEUE,
		activities: exportActivities,
	});

	captures.result = (await exportWorker.runUntil(
		worker.runUntil(
			env.client.workflow.execute(WORKFLOW_NAME, {
				args: [{ ...BASE_INPUT, ...opts.input }],
				taskQueue,
				workflowId: `${taskQueue}-wf`,
			}),
		),
	)) as { status: string; sentCount: number };

	return captures;
}

describe("generateAndSendNewsletterWorkflow — automatic screenshots", () => {
	it("runs none of the screenshot activities for a send that does not ask", async () => {
		const run = await runWorkflow({
			input: { captureScreenshots: undefined },
		});

		expect(run.result.status).toBe("PENDING_APPROVAL");
		expect(run.calls).toEqual(["curate", "hold"]);
		expect(run.curateTargeting).toBeUndefined();
	});

	it("with review on, captures the visible changes excluded and parks the send", async () => {
		const run = await runWorkflow();

		expect(run.result.status).toBe("PENDING_APPROVAL");
		expect(run.calls).toEqual([
			"targeting",
			"curate",
			"createRows",
			"capture",
			"hold",
		]);
		expect(run.curateTargeting).toEqual([
			expect.objectContaining({ tagName: "v1.4.0" }),
		]);
		expect(run.createRows).toEqual([
			{ content: CURATED.content, included: false },
		]);
		expect(run.captureInputs).toEqual([
			{
				imageId: "img-1",
				highlight: {
					title: "Saved filters",
					description: "Filters can be saved.",
				},
			},
		]);
		expect(run.heldContent).toEqual(CURATED.content);
	});

	it("with review off, publishes the captures and delivers them", async () => {
		const run = await runWorkflow({ input: { requireApproval: false } });

		expect(run.result.status).toBe("SENT");
		expect(run.calls).toEqual([
			"targeting",
			"curate",
			"createRows",
			"capture",
			"publish",
			"email",
		]);
		expect(run.createRows[0]?.included).toBe(true);
		expect(run.emailedContent).toMatchObject({
			highlights: [
				{ images: [PUBLISHED_IMAGE] },
				{ title: "Faster export" },
			],
		});
	});

	it("creates no captures when curation marked no visible change", async () => {
		const plain = {
			...CURATED,
			content: {
				...CURATED.content,
				highlights: CURATED.content.highlights.map(
					({ visualChange: _v, captureBrief: _b, ...h }) => h,
				),
			},
		};
		const run = await runWorkflow({ curated: plain });

		expect(run.result.status).toBe("PENDING_APPROVAL");
		expect(run.calls).toEqual(["targeting", "curate", "hold"]);
	});

	it("runs at most two captures at a time and still captures every row", async () => {
		const run = await runWorkflow({
			rows: [
				{ id: "img-1", highlightIndex: 0 },
				{ id: "img-2", highlightIndex: 0 },
				{ id: "img-3", highlightIndex: 0 },
				{ id: "img-4", highlightIndex: 0 },
			],
		});

		expect(run.result.status).toBe("PENDING_APPROVAL");
		expect(run.maxCapturesInFlight).toBeGreaterThan(0);
		expect(run.maxCapturesInFlight).toBeLessThanOrEqual(2);
		const captured = run.captureInputs.map((input) => input.imageId);
		expect(captured.sort()).toEqual(["img-1", "img-2", "img-3", "img-4"]);
		expect(run.failedImages).toEqual([]);
	});

	it("records a capture that never finished and still parks the send", async () => {
		const run = await runWorkflow({ failCapture: true });

		expect(run.result.status).toBe("PENDING_APPROVAL");
		expect(run.failedImages).toEqual([
			{ imageId: "img-1", reason: "The capture did not finish in time." },
		]);
		expect(run.calls).toContain("hold");
	});
});

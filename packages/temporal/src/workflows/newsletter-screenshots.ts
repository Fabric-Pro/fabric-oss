/**
 * Automatic release-notes screenshots inside the generating workflow: after
 * curation and before the send is held or delivered, capture one screenshot
 * for each highlight curation marked as a visible change.
 *
 * With review on, the captures start excluded and the reviewer decides. With
 * review off, the captures that succeed are published and written into the
 * content before delivery. A capture never fails the newsletter: every
 * failure becomes a FAILED row with a reason, and any error here returns the
 * content unchanged.
 */
import type { NewsletterContent } from "@repo/database";
import { log, patched, proxyActivities } from "@temporalio/workflow";
import type {
	captureNewsletterScreenshotActivity as CaptureFn,
	createNewsletterCaptureRowsActivity as CreateRowsFn,
	failNewsletterScreenshotCaptureActivity as FailCaptureFn,
	publishNewsletterScreenshotsActivity as PublishFn,
} from "../activities/newsletter";
import { PROPOSAL_EXPORT_TASK_QUEUE } from "../task-queues";
import { untilRunDeadline } from "./lib/chatgpt-plan-wait";

/** Every new activity call in the generating workflow sits behind this. */
export const NEWSLETTER_AUTO_SCREENSHOTS_PATCH =
	"newsletter-auto-screenshots-2026-11-11";

/**
 * Behind this patch, read only for a send with something to capture: a send
 * delivered without review keeps more of the run for the delivery, and at
 * most `CAPTURE_CONCURRENCY` captures run at once, in row order.
 */
export const NEWSLETTER_CAPTURE_HARDENING_PATCH =
	"newsletter-capture-hardening-2026-11-12";

/** Longest the captures of one send may take together. */
const CAPTURE_BUDGET_MS = 12 * 60_000;
/** What the run keeps after the captures: the hold or the delivery. */
const CAPTURE_RESERVE_MS = 3 * 60_000;
/** What a send delivered without review keeps: publishing, then the mail. */
const CAPTURE_DELIVERY_RESERVE_MS = 6 * 60_000;
/** Below this, captures are not attempted at all. */
const CAPTURE_MIN_BUDGET_MS = 90_000;
/** One capture: sign-in plus at most 15 browser steps. */
export const CAPTURE_START_TO_CLOSE_MS = 4 * 60_000;
/** The export queue's slots per worker; it also runs proposal exports. */
const CAPTURE_CONCURRENCY = 2;

const untilCaptureDeadline = untilRunDeadline(CAPTURE_RESERVE_MS);
const untilDeliveryCaptureDeadline = untilRunDeadline(
	CAPTURE_DELIVERY_RESERVE_MS,
);

const {
	createNewsletterCaptureRowsActivity,
	failNewsletterScreenshotCaptureActivity,
} = proxyActivities<{
	createNewsletterCaptureRowsActivity: typeof CreateRowsFn;
	failNewsletterScreenshotCaptureActivity: typeof FailCaptureFn;
}>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "15 seconds",
	retry: { maximumAttempts: 5, initialInterval: "1s" },
});

const { publishNewsletterScreenshotsActivity } = proxyActivities<{
	publishNewsletterScreenshotsActivity: typeof PublishFn;
}>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "1 minute",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

/** The capture activity on the export queue, bounded by what is left of `budgetMs`. */
export function captureActivity(budgetMs: number) {
	const { captureNewsletterScreenshotActivity } = proxyActivities<{
		captureNewsletterScreenshotActivity: typeof CaptureFn;
	}>({
		taskQueue: PROPOSAL_EXPORT_TASK_QUEUE,
		startToCloseTimeout: CAPTURE_START_TO_CLOSE_MS,
		scheduleToCloseTimeout: budgetMs,
		retry: { maximumAttempts: 1 },
	});
	return captureNewsletterScreenshotActivity;
}

/** True when curation marked any highlight as a visible change to capture. */
function hasCaptureHints(content: NewsletterContent): boolean {
	return content.highlights.some(
		(highlight) =>
			highlight.visualChange === true &&
			Boolean(highlight.captureBrief?.trim()),
	);
}

interface CaptureNewsletterScreenshotsInput {
	sendId: string;
	projectId: string;
	content: NewsletterContent;
	requireApproval: boolean;
	createdByUserId: string;
}

/**
 * Capture the send's screenshots and return the content to hold or deliver:
 * unchanged with review on, with the published images under their highlights
 * with review off. Never throws.
 */
export async function captureNewsletterScreenshots(
	input: CaptureNewsletterScreenshotsInput,
): Promise<NewsletterContent> {
	const { sendId, projectId, content } = input;
	try {
		if (!hasCaptureHints(content)) {
			return content;
		}
		const hardened = patched(NEWSLETTER_CAPTURE_HARDENING_PATCH);
		const untilDeadline =
			hardened && !input.requireApproval
				? untilDeliveryCaptureDeadline
				: untilCaptureDeadline;
		const budgetMs = Math.min(
			CAPTURE_BUDGET_MS,
			untilDeadline() ?? CAPTURE_BUDGET_MS,
		);
		if (budgetMs < CAPTURE_MIN_BUDGET_MS) {
			log.warn(
				"[Newsletter] screenshots skipped: no time left in the run",
				{
					sendId,
				},
			);
			return content;
		}
		const rows = await createNewsletterCaptureRowsActivity({
			sendId,
			projectId,
			content,
			included: !input.requireApproval,
			createdByUserId: input.createdByUserId,
		});
		if (hardened) {
			// Each capture gets what is left of the budget when it starts, so the
			// queued ones cannot outlast it.
			const deadline = Date.now() + budgetMs;
			await inPool(rows, CAPTURE_CONCURRENCY, async (row) => {
				const remainingMs = deadline - Date.now();
				if (remainingMs < CAPTURE_MIN_BUDGET_MS) {
					await failCapture(
						row.id,
						"There was no time left in the run to capture this screenshot.",
						"capture budget spent",
					);
					return;
				}
				await captureRow(content, row, captureActivity(remainingMs));
			});
		} else {
			const capture = captureActivity(budgetMs);
			await Promise.all(
				rows.map((row) => captureRow(content, row, capture)),
			);
		}
		if (input.requireApproval) {
			return content;
		}
		return await publishNewsletterScreenshotsActivity({
			sendId,
			projectId,
			content,
		});
	} catch (error) {
		log.error("[Newsletter] screenshots failed; continuing without them", {
			sendId,
			error: error instanceof Error ? error.message : String(error),
		});
		return content;
	}
}

/** Capture one row; a capture that never finished is recorded as failed. */
async function captureRow(
	content: NewsletterContent,
	row: { id: string; highlightIndex: number },
	capture: ReturnType<typeof captureActivity>,
): Promise<void> {
	const highlight = content.highlights[row.highlightIndex];
	try {
		await capture({
			imageId: row.id,
			highlight: {
				title: highlight?.title ?? "",
				description: highlight?.description ?? "",
			},
		});
	} catch (error) {
		// The activity records its own failures; reaching here means it
		// never ran to the end (timed out, or no worker took it).
		await failCapture(row.id, "The capture did not finish in time.", error);
	}
}

/**
 * Run `work` over `items` with at most `limit` running at once. Items start
 * in order, so a replay schedules the same activities in the same order.
 */
async function inPool<T>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next];
			next += 1;
			if (item !== undefined) {
				await work(item);
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, lane),
	);
}

/** Record a capture the activity could not finish. Never throws. */
export async function failCapture(
	imageId: string,
	reason: string,
	error: unknown,
): Promise<void> {
	log.warn("[Newsletter] screenshot capture did not finish", {
		imageId,
		error: error instanceof Error ? error.message : String(error),
	});
	try {
		await failNewsletterScreenshotCaptureActivity({ imageId, reason });
	} catch (failError) {
		log.error("[Newsletter] screenshot failure not recorded", {
			imageId,
			error:
				failError instanceof Error
					? failError.message
					: String(failError),
		});
	}
}

/**
 * Setup Project Cleanup Schedule
 *
 * Creates a Temporal Schedule that runs the projectDeleteCleanupWorkflow daily at 3 AM UTC.
 * This workflow:
 * 1. Sends reminder emails for projects expiring within 24-48 hours
 * 2. Permanently deletes projects past their 7-day retention period
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-project-cleanup-schedule.ts
 *
 * Options:
 *   --delete    Delete the existing schedule instead of creating it
 *   --status    Check the current status of the schedule
 */

import {
	closeTemporalConnection,
	getScheduleClient,
	ScheduleAlreadyRunning,
	ScheduleNotFoundError,
} from "@repo/temporal";

const SCHEDULE_ID = "project-delete-cleanup";
const WORKFLOW_NAME = "projectDeleteCleanupWorkflow";
const TASK_QUEUE = "fabric-worker";

// Daily at 3 AM UTC
const CRON_SCHEDULE = "0 3 * * *";

interface ScheduleOptions {
	delete?: boolean;
	status?: boolean;
}

function parseArgs(): ScheduleOptions {
	const args = process.argv.slice(2);
	return {
		delete: args.includes("--delete"),
		status: args.includes("--status"),
	};
}

async function checkScheduleStatus() {
	console.log("📊 Checking schedule status...\n");

	const scheduleClient = await getScheduleClient();

	try {
		const handle = scheduleClient.getHandle(SCHEDULE_ID);
		const description = await handle.describe();

		console.log(`Schedule ID: ${SCHEDULE_ID}`);
		console.log(
			`State: ${description.schedule.state?.paused ? "PAUSED" : "ACTIVE"}`,
		);
		console.log(
			`Cron: ${description.schedule.spec?.cronExpressions?.join(", ") || "N/A"}`,
		);

		if (
			description.info.recentActions &&
			description.info.recentActions.length > 0
		) {
			console.log("\nRecent executions:");
			for (const action of description.info.recentActions.slice(0, 5)) {
				const startedAt = action.takenAt?.toISOString() || "Unknown";
				console.log(`  - ${startedAt}`);
			}
		} else {
			console.log("\nNo recent executions");
		}

		if (
			description.info.nextActionTimes &&
			description.info.nextActionTimes.length > 0
		) {
			console.log("\nNext scheduled runs:");
			for (const time of description.info.nextActionTimes.slice(0, 3)) {
				console.log(`  - ${time.toISOString()}`);
			}
		}

		console.log("\n✅ Schedule exists and is configured");
	} catch (error) {
		if (error instanceof ScheduleNotFoundError) {
			console.log(`❌ Schedule "${SCHEDULE_ID}" not found.`);
			console.log("   Run this script without --status to create it.");
		} else {
			throw error;
		}
	}
}

async function deleteSchedule() {
	console.log(`🗑️  Deleting schedule: ${SCHEDULE_ID}\n`);

	const scheduleClient = await getScheduleClient();

	try {
		const handle = scheduleClient.getHandle(SCHEDULE_ID);
		await handle.delete();
		console.log(`✅ Schedule "${SCHEDULE_ID}" deleted successfully`);
	} catch (error) {
		if (error instanceof ScheduleNotFoundError) {
			console.log(
				`⚠️  Schedule "${SCHEDULE_ID}" does not exist (nothing to delete)`,
			);
		} else {
			throw error;
		}
	}
}

async function createSchedule() {
	console.log("🔧 Setting up project cleanup schedule...\n");
	console.log(`Schedule ID: ${SCHEDULE_ID}`);
	console.log(`Workflow: ${WORKFLOW_NAME}`);
	console.log(`Task Queue: ${TASK_QUEUE}`);
	console.log(`Cron: ${CRON_SCHEDULE} (daily at 3 AM UTC)`);
	console.log("");

	const scheduleClient = await getScheduleClient();

	// Check if schedule already exists
	try {
		const handle = scheduleClient.getHandle(SCHEDULE_ID);
		await handle.describe();
		console.log(`⚠️  Schedule "${SCHEDULE_ID}" already exists.`);
		console.log(
			"   Use --delete to remove it first, or --status to check its status.",
		);
		return;
	} catch (error) {
		if (!(error instanceof ScheduleNotFoundError)) {
			throw error;
		}
		// Schedule doesn't exist, we can create it
	}

	try {
		await scheduleClient.create({
			scheduleId: SCHEDULE_ID,
			spec: {
				cronExpressions: [CRON_SCHEDULE],
			},
			action: {
				type: "startWorkflow",
				workflowType: WORKFLOW_NAME,
				taskQueue: TASK_QUEUE,
				args: [
					{
						batchSize: 100, // Process up to 100 projects per run
					},
				],
			},
			state: {
				// Start in active state
				paused: false,
				// Keep notes for documentation
				note: "Cleans up soft-deleted projects after 7-day retention period. Sends reminder emails 24-48 hours before permanent deletion.",
			},
		});

		console.log("\n✅ Schedule created successfully!");
		console.log("\nThe cleanup workflow will:");
		console.log(
			"  1. Send reminder emails for projects expiring within 24-48 hours",
		);
		console.log(
			"  2. Permanently delete projects past their 7-day retention period",
		);
		console.log("\nNext run: Daily at 3 AM UTC");
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`\n⚠️  Schedule "${SCHEDULE_ID}" was created by another process`,
			);
		} else {
			throw error;
		}
	}
}

async function main() {
	const options = parseArgs();

	try {
		if (options.status) {
			await checkScheduleStatus();
		} else if (options.delete) {
			await deleteSchedule();
		} else {
			await createSchedule();
		}
	} finally {
		await closeTemporalConnection();
	}
}

main()
	.then(() => {
		console.log("\n✅ Done!");
		process.exit(0);
	})
	.catch((error) => {
		console.error(
			"\n❌ Error:",
			error instanceof Error ? error.message : error,
		);
		process.exit(1);
	});

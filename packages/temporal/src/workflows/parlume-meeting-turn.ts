import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { executeParlumeMeetingTurn, failParlumeMeetingTurn } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "3 minutes",
	retry: { maximumAttempts: 1 },
});

export async function parlumeMeetingTurnWorkflow(input: {
	turnId: string;
}): Promise<void> {
	try {
		await executeParlumeMeetingTurn(input);
	} catch {
		await failParlumeMeetingTurn({
			turnId: input.turnId,
			error: "Parlume meeting turn timed out or the worker stopped.",
		});
	}
}

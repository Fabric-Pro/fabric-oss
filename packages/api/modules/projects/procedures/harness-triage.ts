import { tenantProtectedProcedure } from "../../../orpc/procedures";
import { privateTriageCommands } from "../lib/harness-triage-commands";
import {
	triageList,
	triageListInput,
	triageReviewInput,
	triageRun,
	triageRunDetail,
	triageRunInput,
	triageStartInput,
} from "../lib/harness-triage-contracts";

const privateProcedure = tenantProtectedProcedure.use(
	async ({ context, next }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		return next();
	},
);
export const harnessTriageProcedures = {
	list: privateProcedure
		.input(triageListInput)
		.output(triageList)
		.handler(({ input, context }) =>
			privateTriageCommands.list(
				{ userId: context.user.id, credential: { kind: "SESSION" } },
				input,
			),
		),
	start: privateProcedure
		.input(triageStartInput)
		.output(triageRun)
		.handler(({ input, context }) =>
			privateTriageCommands.start(
				{ userId: context.user.id, credential: { kind: "SESSION" } },
				input,
			),
		),
	status: privateProcedure
		.input(triageRunInput)
		.output(triageRun)
		.handler(({ input, context }) =>
			privateTriageCommands.status(
				{ userId: context.user.id, credential: { kind: "SESSION" } },
				input,
			),
		),
	result: privateProcedure
		.input(triageRunInput)
		.output(triageRunDetail)
		.handler(({ input, context }) =>
			privateTriageCommands.result(
				{ userId: context.user.id, credential: { kind: "SESSION" } },
				input,
			),
		),
	cancel: privateProcedure
		.input(triageRunInput)
		.output(triageRun)
		.handler(({ input, context }) =>
			privateTriageCommands.cancel(
				{ userId: context.user.id, credential: { kind: "SESSION" } },
				input,
			),
		),
	review: privateProcedure
		.input(triageReviewInput)
		.output(triageRunDetail)
		.handler(({ input, context }) =>
			privateTriageCommands.review(
				{ userId: context.user.id, credential: { kind: "SESSION" } },
				input,
			),
		),
};

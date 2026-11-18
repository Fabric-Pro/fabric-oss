import { TestWorkflowEnvironment } from "@temporalio/testing";

// The moving default changed alongside a time-skipping regression. Bump only
// after approval-replay and the time-skipping workflow suites pass on the new version.
export const TEMPORAL_TEST_SERVER_VERSION = "v1.40.0";

type Options = Parameters<typeof TestWorkflowEnvironment.createTimeSkipping>[0];

export function pinnedTimeSkippingOptions(options?: Options): Options {
	const executable = options?.server?.executable;
	const existingPath = process.env.TEMPORAL_TEST_SERVER_PATH;
	return {
		...options,
		server: {
			...options?.server,
			executable: existingPath
				? { type: "existing-path", path: existingPath }
				: executable?.type === "existing-path"
					? executable
					: {
							...executable,
							type: "cached-download",
							version: TEMPORAL_TEST_SERVER_VERSION,
						},
		},
	};
}

const createTimeSkipping = TestWorkflowEnvironment.createTimeSkipping.bind(
	TestWorkflowEnvironment,
);
TestWorkflowEnvironment.createTimeSkipping = (options) =>
	createTimeSkipping(pinnedTimeSkippingOptions(options));

import { QUESTIONS as baseline } from "../../questions.mjs";

export const QUESTIONS = {
	...baseline,
	failure_success: `${baseline.failure_success} Trace the failure from the call to the returned result. Look for an unsuccessful repository search converted into zero matches, an unavailable connection dropped from a normal tool list, a tool error stream event ignored while the turn returns success, or a refused generation call that returns default content with no failure status.`,
};

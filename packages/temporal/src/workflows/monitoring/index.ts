/**
 * Monitoring workflows.
 *
 * Re-exports every monitoring workflow. The top-level
 * `packages/temporal/src/workflows/index.ts` re-exports the lot so
 * Temporal's workflow bundler picks them up automatically.
 */

export {
	type ErrorRateWeeklyDigestInput,
	errorRateWeeklyDigestWorkflow,
} from "./error-rate-weekly-digest";
export {
	acknowledgedSignal,
	type IncidentLifecycleInput,
	incidentLifecycleWorkflow,
	resolvedSignal,
} from "./incident-lifecycle";
export {
	type ProjectServiceAlertDigestInput,
	projectServiceAlertDigestWorkflow,
} from "./project-service-alert-digest";
export {
	type PruneOldIncidentsInput,
	pruneOldIncidentsWorkflow,
} from "./prune-old-incidents";
export {
	type StatusAnnouncementNotificationInput,
	statusAnnouncementNotificationWorkflow,
} from "./status-announcement-notifications";
export {
	type StatusPagePollerInput,
	statusPagePollerWorkflow,
} from "./status-page-poller";
export {
	type SyntheticProbeWorkflowInput,
	syntheticProbeWorkflow,
} from "./synthetic-probe";

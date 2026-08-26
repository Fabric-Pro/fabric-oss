/**
 * Monitoring activities.
 *
 * Re-exports every activity used by the four monitoring workflows. The
 * top-level `packages/temporal/src/activities/index.ts` re-exports the
 * lot so the worker picks them up automatically.
 */

export {
	type CloseIntegrationIncidentInput,
	type CloseIntegrationIncidentOutput,
	closeIntegrationIncident,
} from "./close-integration-incident";
export {
	type GetProviderRegistrationInput,
	getProviderRegistration,
	type ListProviderRegistryInput,
	listProviderRegistry,
	type ProviderRegistrySerializable,
} from "./list-provider-registry";
export {
	type MarkProviderNotConfiguredInput,
	type MarkProviderNotConfiguredOutput,
	markProviderNotConfigured,
} from "./mark-provider-not-configured";
export {
	type NotifyIncidentInput,
	type NotifyIncidentOutput,
	notifyIncident,
} from "./notify-incident";
export {
	type PollStatusPageInput,
	type PollStatusPageOpenIncident,
	type PollStatusPageOutput,
	pollStatusPage,
} from "./poll-status-page";
export {
	type DispatchProjectServiceAlertDigestInput,
	type DispatchProjectServiceAlertDigestOutput,
	dispatchProjectServiceAlertDigestActivity,
} from "./project-service-alert-digest";
export {
	type PruneIncidentsInput,
	type PruneIncidentsOutput,
	pruneIncidents,
} from "./prune-incidents";
export type {
	IncidentDetectionMethod,
	IncidentEventType,
	IncidentKind,
	IncidentSeverity,
	IncidentStatus,
	ProviderHealthStatus,
	SyntheticProbeProviderKey,
} from "./shared-types";
export {
	type DispatchStatusAnnouncementNotificationsActivityOutput,
	type DispatchStatusAnnouncementNotificationsInput,
	dispatchStatusAnnouncementNotificationsActivity,
} from "./status-announcement-notifications";
export { runSyntheticProbe } from "./synthetic-probe";
export type { SyntheticProbeOutput } from "./synthetic-probe-shared";
export {
	type UpsertIntegrationIncidentInput,
	type UpsertIntegrationIncidentOutput,
	upsertIntegrationIncident,
} from "./upsert-integration-incident";
export {
	type DispatchWeeklyDigestInput,
	type DispatchWeeklyDigestOutput,
	dispatchWeeklyDigestActivity,
} from "./weekly-digest";

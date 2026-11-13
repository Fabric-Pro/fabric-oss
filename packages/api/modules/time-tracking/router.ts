import { confirmTimeSuggestionProcedure } from "./procedures/confirm-suggestion";
import { createTimeEntryProcedure } from "./procedures/create-entry";
import { deleteTimeEntryProcedure } from "./procedures/delete-entry";
import { dismissTimeSuggestionProcedure } from "./procedures/dismiss-suggestion";
import { generateTimeSuggestionsProcedure } from "./procedures/generate-suggestions";
import { listTimeEntriesProcedure } from "./procedures/list-entries";
import { listTimeEntriesForStoryProcedure } from "./procedures/list-for-story";
import { listLoggableProjectsProcedure } from "./procedures/list-loggable-projects";
import { listTimeSuggestionsProcedure } from "./procedures/list-suggestions";
import {
	exportOrganizationTimeReportCsvProcedure,
	organizationTimeReportProcedure,
} from "./procedures/organization-report";
import {
	getOrganizationTimeSettingsProcedure,
	updateOrganizationTimeSettingsProcedure,
} from "./procedures/organization-settings";
import {
	exportProjectTimeReportCsvProcedure,
	projectTimeReportProcedure,
} from "./procedures/project-report";
import {
	getProjectTimeSettingsProcedure,
	updateProjectTimeSettingsProcedure,
} from "./procedures/project-settings";
import { timeSuggestionStatusProcedure } from "./procedures/suggestion-status";
import { getTimerProcedure } from "./procedures/timer-get";
import {
	pauseTimerProcedure,
	resumeTimerProcedure,
} from "./procedures/timer-pause-resume";
import { setTimerPreferenceProcedure } from "./procedures/timer-preference";
import { proposeTimerStopProcedure } from "./procedures/timer-propose-stop";
import { startTimerProcedure } from "./procedures/timer-start";
import {
	discardTimerProcedure,
	stopTimerProcedure,
} from "./procedures/timer-stop";
import { updateTimerProcedure } from "./procedures/timer-update";
import { updateTimeEntryProcedure } from "./procedures/update-entry";
import { updateTimeSuggestionProcedure } from "./procedures/update-suggestion";

/**
 * Manual time tracking: a member logs, edits, deletes and lists their own
 * confirmed time entries across the organization's projects, and confirms or
 * dismisses the entries Fabric suggests from their own activity, and runs a
 * timer that saves as entries when it stops;
 * administrators set each project's billing model and time policy and read
 * everyone's time in reports.
 */
export const timeTrackingRouter = {
	listLoggableProjects: listLoggableProjectsProcedure,
	listEntries: listTimeEntriesProcedure,
	listForStory: listTimeEntriesForStoryProcedure,
	createEntry: createTimeEntryProcedure,
	updateEntry: updateTimeEntryProcedure,
	deleteEntry: deleteTimeEntryProcedure,
	generateSuggestions: generateTimeSuggestionsProcedure,
	suggestionStatus: timeSuggestionStatusProcedure,
	listSuggestions: listTimeSuggestionsProcedure,
	updateSuggestion: updateTimeSuggestionProcedure,
	confirmSuggestion: confirmTimeSuggestionProcedure,
	dismissSuggestion: dismissTimeSuggestionProcedure,
	getProjectSettings: getProjectTimeSettingsProcedure,
	updateProjectSettings: updateProjectTimeSettingsProcedure,
	getOrganizationSettings: getOrganizationTimeSettingsProcedure,
	updateOrganizationSettings: updateOrganizationTimeSettingsProcedure,
	projectReport: projectTimeReportProcedure,
	organizationReport: organizationTimeReportProcedure,
	exportProjectReportCsv: exportProjectTimeReportCsvProcedure,
	exportOrganizationReportCsv: exportOrganizationTimeReportCsvProcedure,
	/**
	 * The caller's running timer. Its procedures' audit actions share the
	 * `activity.timeTracking.timer.` prefix, which `proposeStop` leaves out
	 * of the caller's activity (`TIMER_ACTION_PREFIX`); keep the key.
	 */
	timer: {
		get: getTimerProcedure,
		start: startTimerProcedure,
		pause: pauseTimerProcedure,
		resume: resumeTimerProcedure,
		update: updateTimerProcedure,
		proposeStop: proposeTimerStopProcedure,
		stop: stopTimerProcedure,
		discard: discardTimerProcedure,
		setPreference: setTimerPreferenceProcedure,
	},
};

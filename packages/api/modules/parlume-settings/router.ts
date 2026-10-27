/**
 * Parlume (meeting assistant) settings an organization configures for itself:
 * its Attendee meeting bot and its realtime voice deployment. The media bridge
 * and webhook stay operator settings.
 */

import { getParlumeSettings } from "./procedures/get-parlume-settings";
import {
	testParlumeAttendeeConnection,
	testParlumeRealtimeVoice,
} from "./procedures/test-parlume-connections";
import { updateParlumeSettings } from "./procedures/update-parlume-settings";

export const parlumeSettingsRouter = {
	get: getParlumeSettings,
	update: updateParlumeSettings,
	testAttendee: testParlumeAttendeeConnection,
	testRealtimeVoice: testParlumeRealtimeVoice,
};

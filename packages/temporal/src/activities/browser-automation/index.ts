/**
 * Browser Automation Module
 *
 * Exports browser automation activities and types.
 */

export * from "./activities";
export {
	closeAllSessions,
	generateSessionId,
	getSessionCount,
} from "./session-manager";
export * from "./types";

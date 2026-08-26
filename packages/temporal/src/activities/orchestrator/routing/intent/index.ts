/**
 * Intent Detection Module
 *
 * Exports user intent detection functionality for routing.
 */

export { detectFabricPattern } from "./fabric-pattern-detector";
// Types
export type {
	FabricAiCapability,
	PrioritizedCapabilities,
	UserIntent,
} from "./types";
// Detectors
export { detectUserIntent } from "./user-intent-detector";

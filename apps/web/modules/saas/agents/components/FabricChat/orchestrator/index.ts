/**
 * Orchestrator Chat Components
 *
 * Extracted components from FabricTemporalOrchestratorChat for better maintainability.
 */

// Re-export shared components for backward compatibility
export { ActiveContextIndicator } from "../shared/ActiveContextIndicator";
// Components
export { ApprovalDialog } from "./ApprovalDialog";
export type {
	DocumentArtifact,
	SourceReference,
} from "./ArtifactsPanel";
// Artifacts Panel
export { ArtifactsPanel, ArtifactsPanelTrigger } from "./ArtifactsPanel";
export { ConnectionRequiredDialog } from "./ConnectionRequiredDialog";
// Execution Dashboard (Enhanced Visualization)
// Journey Progress (Multi-turn conversation tracking)
// Memory Panel (Learned patterns & episodic memory)
export { MemoryPanel, MemoryPanelTrigger } from "./MemoryPanel";
export { PhaseIndicator } from "./PhaseIndicator";
// Plan Modification View (Follow-up plan changes)
// Planning Transparency & Visualization (Phase 6.1)
// Types
export * from "./types";
// Utilities
export * from "./utils";

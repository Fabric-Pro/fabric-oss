/**
 * CUGA (Configurable Universal Generalist Agent) UI Components
 *
 * These components provide visualization and interaction for CUGA's capabilities:
 * - Task decomposition and subtask tree view
 * - Code execution panel with output display
 * - Variables inspector for cross-task state
 * - Human-in-the-loop approval dialogs
 * - Browser view with screenshot and DOM overlays
 */

export { CugaAuthenticatedChat } from "./CugaAuthenticatedChat";
export { CugaExecutionView } from "./CugaExecutionView";

// Types
export type { CugaExecutionState } from "./types";
// Hooks

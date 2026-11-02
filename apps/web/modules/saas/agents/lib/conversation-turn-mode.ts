export const DIRECT_EXECUTION_MODE = "direct";
export const RESEARCH_EXECUTION_MODE = "research";

export function isOrchestratorTurn(turn: {
	executionMode: string | null;
}): boolean {
	return (
		turn.executionMode !== DIRECT_EXECUTION_MODE &&
		turn.executionMode !== RESEARCH_EXECUTION_MODE
	);
}

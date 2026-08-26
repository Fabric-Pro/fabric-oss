/**
 * CUGA Component Types
 *
 * Type definitions for CUGA UI components
 */

/**
 * Status of a subtask in the task decomposition
 */
export type CugaSubtaskStatus =
	| "pending"
	| "running"
	| "complete"
	| "failed"
	| "skipped";

/**
 * A subtask in the task decomposition tree
 */
export interface CugaSubtask {
	id: string;
	description: string;
	status: CugaSubtaskStatus;
	/** App/service this subtask targets (e.g., "gmail", "api", "browser") */
	app?: string;
	/** Type of operation (e.g., "read", "write", "navigate") */
	type?: string;
	/** Dependencies on other subtask IDs */
	dependencies?: string[];
	/** Output/result of the subtask */
	output?: string;
	/** Error message if failed */
	error?: string;
	/** Execution time in milliseconds */
	executionTimeMs?: number;
	/** Child subtasks for nested decomposition */
	children?: CugaSubtask[];
}

/**
 * A variable in the CUGA Variables Manager
 */
export interface CugaVariable {
	name: string;
	type: string;
	value: unknown;
	/** Human-readable preview of the value */
	valuePreview?: string;
	/** Description of what this variable contains */
	description?: string;
	/** Number of items if this is a collection */
	countItems?: number;
	/** When this variable was last updated */
	updatedAt?: Date;
	/** Which subtask created/updated this variable */
	sourceSubtaskId?: string;
}

/**
 * Code execution result from CUGA Code Agent
 */
export interface CugaCodeExecution {
	id: string;
	code: string;
	language: "python" | "javascript";
	status: "pending" | "running" | "complete" | "failed";
	output?: string;
	error?: string;
	/** Variables created/modified by this execution */
	variables?: CugaVariable[];
	executionTimeMs?: number;
	/** Sandbox type used */
	sandbox?: "local" | "docker" | "e2b";
}

/**
 * Human-in-the-loop request from CUGA
 */
export interface CugaHitlRequest {
	id: string;
	type: "approval" | "input" | "confirmation" | "selection";
	message: string;
	/** Context about what action is being requested */
	context?: {
		subtaskId?: string;
		action?: string;
		riskLevel?: "low" | "medium" | "high" | "critical";
	};
	/** Options for selection type */
	options?: Array<{
		id: string;
		label: string;
		description?: string;
	}>;
	/** Default value for input type */
	defaultValue?: string;
	/** Whether this request is still pending */
	pending: boolean;
	/** User's response */
	response?: {
		approved?: boolean;
		value?: string;
		selectedOptionId?: string;
	};
}

/**
 * Browser element with BID marker
 */
interface CugaBrowserElement {
	bid: string;
	tag: string;
	text?: string;
	bbox?: { x: number; y: number; width: number; height: number };
	isActive?: boolean;
}

/**
 * Browser action being performed
 */
interface CugaBrowserAction {
	type:
		| "click"
		| "type"
		| "select_option"
		| "scroll"
		| "go_back"
		| "navigate";
	bid?: string;
	value?: string;
	status: "pending" | "executing" | "complete" | "failed";
	error?: string;
}

/**
 * Browser state snapshot
 */
interface CugaBrowserState {
	screenshot: string;
	url: string;
	elements?: CugaBrowserElement[];
	viewport?: { width: number; height: number };
}

/**
 * Overall CUGA execution state
 */
export interface CugaExecutionState {
	status:
		| "idle"
		| "planning"
		| "executing"
		| "waiting_hitl"
		| "complete"
		| "failed";
	subtasks: CugaSubtask[];
	variables: Record<string, CugaVariable>;
	codeExecutions: CugaCodeExecution[];
	hitlRequests: CugaHitlRequest[];
	currentSubtaskId?: string;
	thoughts?: string;
	finalAnswer?: string;
	error?: string;
	/** Browser state for browser automation tasks */
	browserState?: CugaBrowserState;
	/** Current browser action */
	browserAction?: CugaBrowserAction;
}

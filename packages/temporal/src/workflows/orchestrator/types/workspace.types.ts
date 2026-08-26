/**
 * Workspace Types
 *
 * Defines workspace-related types for context preservation across agent delegations.
 * Includes files, code executions, and browser states.
 */

import type { AgentVariable } from "./variable.types";

// =============================================================================
// Workspace File
// =============================================================================

/**
 * Workspace file stored during orchestrator execution.
 * Used to preserve context across agent delegations.
 */
export interface WorkspaceFile {
	/** Unique file ID */
	id: string;
	/** Virtual path (e.g., "/code/prime_checker.py") */
	path: string;
	/** File name */
	name: string;
	/** File extension */
	extension?: string;
	/** MIME type */
	mimeType?: string;
	/** File content */
	content: string;
	/** Content size in bytes */
	size: number;
	/** File type category */
	fileType: "document" | "code" | "data" | "config" | "output" | "artifact";
	/** Which agent created this file */
	createdBy: string;
	/** When the file was created */
	createdAt: string;
	/** Metadata */
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Code Execution
// =============================================================================

/**
 * Code execution result stored in workspace.
 */
export interface WorkspaceCodeExecution {
	/** Unique execution ID */
	id: string;
	/** Code that was executed */
	code: string;
	/** Programming language */
	language: string;
	/** Execution output (stdout) */
	output?: string;
	/** Execution error (stderr) */
	error?: string;
	/** Exit code */
	exitCode?: number;
	/** Execution duration in ms */
	durationMs: number;
	/** Which agent executed this */
	executedBy: string;
	/** When the code was executed */
	executedAt: string;
	/** Files created by this execution */
	createdFiles?: string[];
}

// =============================================================================
// Browser State
// =============================================================================

/**
 * Browser state snapshot stored in workspace.
 */
export interface WorkspaceBrowserState {
	/** Unique snapshot ID */
	id: string;
	/** Current URL */
	url: string;
	/** Page title */
	title?: string;
	/** Screenshot (base64 or URL) */
	screenshot?: string;
	/** DOM snapshot (simplified) */
	domSnapshot?: string;
	/** Cookies */
	cookies?: Array<{ name: string; value: string; domain: string }>;
	/** Which agent captured this */
	capturedBy: string;
	/** When the snapshot was captured */
	capturedAt: string;
}

// =============================================================================
// Orchestrator Workspace
// =============================================================================

/**
 * Orchestrator workspace for preserving context across agent delegations.
 * This is passed to generalist agents so they have full context.
 */
export interface OrchestratorWorkspace {
	/** Workspace ID (same as execution ID) */
	id: string;
	/** User ID for multi-tenancy */
	userId: string;
	/** Organization ID for multi-tenancy */
	organizationId?: string;
	/** Files in the workspace */
	files: WorkspaceFile[];
	/** Code executions */
	codeExecutions: WorkspaceCodeExecution[];
	/** Browser state snapshots */
	browserStates: WorkspaceBrowserState[];
	/** Variables (cross-agent) */
	variables: Record<string, AgentVariable>;
	/** Subtasks completed */
	completedSubtasks: Array<{
		id: string;
		description: string;
		result: string;
		completedAt: string;
	}>;
	/** Created at */
	createdAt: string;
	/** Last updated */
	updatedAt: string;
}

/**
 * Step I/O Contracts
 *
 * Phase 4.2: Explicit input/output declarations for steps.
 * Enables automatic artifact wiring and validation.
 */

import { logger } from "@repo/logs";
import type { TaskStep as BaseTaskStep } from "../../../workflows/orchestrator/types";

// Extended TaskStep with optional fields for I/O contracts
interface TaskStep extends BaseTaskStep {
	dependencies?: string[];
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Types
// =============================================================================

export interface IOParameter {
	name: string;
	type: string; // TypeScript-like type: "string", "number", "boolean", "object", "array", etc.
	artifactType?: string; // Reference to artifact type: "code", "document", "data", "api_response"
	description?: string;
	required: boolean;
	defaultValue?: unknown;
}

export interface InputRequirement extends IOParameter {
	source?: string; // Step ID that produces this, or "input" for workflow input
	transform?: string; // Optional transformation expression
}

export interface OutputDeclaration extends IOParameter {
	// Output-specific fields can be added here
}

export interface StepIOContract {
	stepId: string;
	requires: InputRequirement[];
	produces: OutputDeclaration[];
	inputSchema?: JsonSchema;
	outputSchema?: JsonSchema;
}

export interface JsonSchema {
	type: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	additionalProperties?: boolean;
	description?: string;
	enum?: unknown[];
	default?: unknown;
}

export interface ContractValidationResult {
	valid: boolean;
	errors: ContractValidationError[];
	warnings: ContractValidationWarning[];
	wiring: ArtifactWiring[];
}

export interface ContractValidationError {
	stepId: string;
	type:
		| "missing_input"
		| "type_mismatch"
		| "circular_dependency"
		| "invalid_source";
	message: string;
	inputName?: string;
	expectedType?: string;
	actualType?: string;
}

export interface ContractValidationWarning {
	stepId: string;
	type: "unused_output" | "implicit_conversion" | "missing_description";
	message: string;
}

export interface ArtifactWiring {
	fromStep: string;
	fromOutput: string;
	toStep: string;
	toInput: string;
	artifactType?: string;
}

// =============================================================================
// Contract Inference
// =============================================================================

/**
 * Infer I/O contract from step description and executor.
 * Uses heuristics based on common patterns.
 */
export function inferStepContract(step: TaskStep): StepIOContract {
	const requires: InputRequirement[] = [];
	const produces: OutputDeclaration[] = [];
	const descLower = step.description.toLowerCase();

	// Infer inputs based on dependencies
	if (step.dependencies && step.dependencies.length > 0) {
		for (const depId of step.dependencies) {
			requires.push({
				name: `input_from_${depId}`,
				type: "unknown",
				required: true,
				source: depId,
				description: `Output from step ${depId}`,
			});
		}
	}

	// Infer outputs based on step type and description
	if (
		step.type === "generate" ||
		descLower.includes("generate") ||
		descLower.includes("create")
	) {
		if (
			descLower.includes("code") ||
			descLower.includes("script") ||
			descLower.includes("function")
		) {
			produces.push({
				name: "generated_code",
				type: "string",
				artifactType: "code",
				required: true,
				description: "Generated code",
			});
		} else if (
			descLower.includes("document") ||
			descLower.includes("prd") ||
			descLower.includes("spec")
		) {
			produces.push({
				name: "generated_document",
				type: "string",
				artifactType: "document",
				required: true,
				description: "Generated document",
			});
		} else {
			produces.push({
				name: "generated_content",
				type: "string",
				required: true,
				description: "Generated content",
			});
		}
	}

	if (
		step.type === "research" ||
		descLower.includes("search") ||
		descLower.includes("find") ||
		descLower.includes("research")
	) {
		requires.push({
			name: "search_query",
			type: "string",
			required: true,
			description: "Search query or research topic",
		});
		produces.push({
			name: "research_results",
			type: "array",
			artifactType: "data",
			required: true,
			description: "Research findings",
		});
	}

	if (
		step.type === "api" ||
		descLower.includes("api") ||
		descLower.includes("fetch") ||
		descLower.includes("request")
	) {
		produces.push({
			name: "api_response",
			type: "object",
			artifactType: "api_response",
			required: true,
			description: "API response data",
		});
	}

	if (
		descLower.includes("analyze") ||
		descLower.includes("evaluate") ||
		descLower.includes("review")
	) {
		requires.push({
			name: "content_to_analyze",
			type: "string",
			required: true,
			description: "Content to be analyzed",
		});
		produces.push({
			name: "analysis_result",
			type: "object",
			artifactType: "data",
			required: true,
			description: "Analysis results",
		});
	}

	// Default output if none inferred
	if (produces.length === 0) {
		produces.push({
			name: "result",
			type: "unknown",
			required: true,
			description: "Step output",
		});
	}

	return {
		stepId: step.id,
		requires,
		produces,
	};
}

/**
 * Infer contracts for all steps in a plan.
 */
export function inferPlanContracts(
	steps: TaskStep[],
): Map<string, StepIOContract> {
	const contracts = new Map<string, StepIOContract>();

	for (const step of steps) {
		contracts.set(step.id, inferStepContract(step));
	}

	return contracts;
}

// =============================================================================
// Contract Validation
// =============================================================================

/**
 * Validate I/O contracts for a plan.
 */
export function validateContracts(
	contracts: Map<string, StepIOContract>,
	workflowInputs?: Record<string, unknown>,
): ContractValidationResult {
	const errors: ContractValidationError[] = [];
	const warnings: ContractValidationWarning[] = [];
	const wiring: ArtifactWiring[] = [];

	// Build output registry: stepId -> outputName -> type
	const outputRegistry = new Map<string, Map<string, IOParameter>>();
	for (const [stepId, contract] of contracts) {
		const outputs = new Map<string, IOParameter>();
		for (const output of contract.produces) {
			outputs.set(output.name, output);
		}
		outputRegistry.set(stepId, outputs);
	}

	// Validate each contract
	for (const [stepId, contract] of contracts) {
		// Check each input requirement
		for (const input of contract.requires) {
			if (input.source === "input") {
				// Check workflow input
				if (
					workflowInputs &&
					!(input.name in workflowInputs) &&
					input.required
				) {
					errors.push({
						stepId,
						type: "missing_input",
						message: `Required workflow input '${input.name}' is not provided`,
						inputName: input.name,
					});
				}
			} else if (input.source) {
				// Check step output
				const sourceOutputs = outputRegistry.get(input.source);
				if (!sourceOutputs) {
					errors.push({
						stepId,
						type: "invalid_source",
						message: `Source step '${input.source}' not found for input '${input.name}'`,
						inputName: input.name,
					});
				} else {
					// Find matching output
					let matchedOutput: IOParameter | undefined;

					// First try exact name match
					for (const [outputName, output] of sourceOutputs) {
						if (
							outputName === input.name ||
							input.name.includes(outputName)
						) {
							matchedOutput = output;
							break;
						}
					}

					// Then try first output if only one exists
					if (!matchedOutput && sourceOutputs.size === 1) {
						matchedOutput = sourceOutputs.values().next().value;
					}

					if (matchedOutput) {
						// Check type compatibility
						if (
							input.type !== "unknown" &&
							matchedOutput.type !== "unknown"
						) {
							if (
								!isTypeCompatible(
									matchedOutput.type,
									input.type,
								)
							) {
								warnings.push({
									stepId,
									type: "implicit_conversion",
									message: `Type conversion from '${matchedOutput.type}' to '${input.type}' for input '${input.name}'`,
								});
							}
						}

						// Record wiring
						wiring.push({
							fromStep: input.source,
							fromOutput: matchedOutput.name,
							toStep: stepId,
							toInput: input.name,
							artifactType:
								matchedOutput.artifactType ||
								input.artifactType,
						});
					} else if (input.required) {
						errors.push({
							stepId,
							type: "missing_input",
							message: `No matching output found in step '${input.source}' for required input '${input.name}'`,
							inputName: input.name,
						});
					}
				}
			}
		}

		// Check for missing descriptions
		for (const param of [...contract.requires, ...contract.produces]) {
			if (!param.description) {
				warnings.push({
					stepId,
					type: "missing_description",
					message: `Parameter '${param.name}' is missing a description`,
				});
			}
		}
	}

	// Check for circular dependencies
	const circularDeps = detectCircularDependencies(wiring);
	for (const cycle of circularDeps) {
		errors.push({
			stepId: cycle[0],
			type: "circular_dependency",
			message: `Circular dependency detected: ${cycle.join(" -> ")}`,
		});
	}

	// Check for unused outputs
	const usedOutputs = new Set(
		wiring.map((w) => `${w.fromStep}.${w.fromOutput}`),
	);
	for (const [stepId, contract] of contracts) {
		for (const output of contract.produces) {
			const key = `${stepId}.${output.name}`;
			if (!usedOutputs.has(key)) {
				warnings.push({
					stepId,
					type: "unused_output",
					message: `Output '${output.name}' is not used by any subsequent step`,
				});
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		wiring,
	};
}

/**
 * Check if source type is compatible with target type.
 */
function isTypeCompatible(sourceType: string, targetType: string): boolean {
	if (sourceType === targetType) {
		return true;
	}
	if (targetType === "unknown" || sourceType === "unknown") {
		return true;
	}
	if (targetType === "string") {
		return true; // Everything can be converted to string
	}

	// Array compatibility
	if (targetType === "array" && sourceType.endsWith("[]")) {
		return true;
	}

	// Object compatibility
	if (
		targetType === "object" &&
		!["string", "number", "boolean", "array"].includes(sourceType)
	) {
		return true;
	}

	return false;
}

/**
 * Detect circular dependencies in wiring.
 */
function detectCircularDependencies(wiring: ArtifactWiring[]): string[][] {
	const graph = new Map<string, Set<string>>();

	// Build adjacency list
	for (const wire of wiring) {
		if (!graph.has(wire.fromStep)) {
			graph.set(wire.fromStep, new Set());
		}
		graph.get(wire.fromStep)?.add(wire.toStep);
	}

	const cycles: string[][] = [];
	const visited = new Set<string>();
	const recursionStack = new Set<string>();
	const path: string[] = [];

	function dfs(node: string): boolean {
		visited.add(node);
		recursionStack.add(node);
		path.push(node);

		const neighbors = graph.get(node) || new Set();
		for (const neighbor of neighbors) {
			if (!visited.has(neighbor)) {
				if (dfs(neighbor)) {
					return true;
				}
			} else if (recursionStack.has(neighbor)) {
				// Found cycle
				const cycleStart = path.indexOf(neighbor);
				cycles.push([...path.slice(cycleStart), neighbor]);
				return true;
			}
		}

		path.pop();
		recursionStack.delete(node);
		return false;
	}

	for (const node of graph.keys()) {
		if (!visited.has(node)) {
			dfs(node);
		}
	}

	return cycles;
}

// =============================================================================
// Automatic Wiring
// =============================================================================

/**
 * Automatically wire step inputs to outputs based on contracts.
 */
export function autoWireSteps(
	steps: TaskStep[],
	contracts: Map<string, StepIOContract>,
): TaskStep[] {
	const validation = validateContracts(contracts);

	// Apply wiring to steps
	for (const step of steps) {
		const contract = contracts.get(step.id);
		if (!contract) {
			continue;
		}

		// Find inputs that need wiring
		const stepWiring = validation.wiring.filter(
			(w) => w.toStep === step.id,
		);

		if (stepWiring.length > 0) {
			// Ensure step has dependencies for all wired inputs
			const requiredDeps = new Set(stepWiring.map((w) => w.fromStep));
			step.dependencies = [
				...new Set([...(step.dependencies || []), ...requiredDeps]),
			];

			// Store wiring metadata
			step.metadata = {
				...step.metadata,
				ioWiring: stepWiring,
			};
		}
	}

	return steps;
}

// =============================================================================
// Contract Visualization
// =============================================================================

/**
 * Generate a visualization of step contracts and wiring.
 */
export function visualizeContracts(
	contracts: Map<string, StepIOContract>,
	wiring: ArtifactWiring[],
): string {
	const lines: string[] = ["# Step I/O Contracts", ""];

	for (const [stepId, contract] of contracts) {
		lines.push(`## Step: ${stepId}`);
		lines.push("");

		if (contract.requires.length > 0) {
			lines.push("### Inputs");
			for (const input of contract.requires) {
				const source = input.source ? ` (from: ${input.source})` : "";
				const req = input.required ? " *required*" : "";
				lines.push(`- **${input.name}**: ${input.type}${source}${req}`);
				if (input.description) {
					lines.push(`  - ${input.description}`);
				}
			}
			lines.push("");
		}

		if (contract.produces.length > 0) {
			lines.push("### Outputs");
			for (const output of contract.produces) {
				const artifact = output.artifactType
					? ` [${output.artifactType}]`
					: "";
				lines.push(`- **${output.name}**: ${output.type}${artifact}`);
				if (output.description) {
					lines.push(`  - ${output.description}`);
				}
			}
			lines.push("");
		}
	}

	if (wiring.length > 0) {
		lines.push("## Wiring");
		lines.push("");
		for (const wire of wiring) {
			lines.push(
				`- ${wire.fromStep}.${wire.fromOutput} -> ${wire.toStep}.${wire.toInput}`,
			);
		}
	}

	return lines.join("\n");
}

// =============================================================================
// Activity Functions
// =============================================================================

/**
 * Infer and validate I/O contracts for a plan.
 */
export async function inferAndValidateContractsActivity(
	steps: TaskStep[],
	workflowInputs?: Record<string, unknown>,
): Promise<{
	contracts: Array<[string, StepIOContract]>;
	validation: ContractValidationResult;
}> {
	logger.debug("[StepIOContracts] Inferring contracts", {
		stepCount: steps.length,
	});

	const contracts = inferPlanContracts(steps);
	const validation = validateContracts(contracts, workflowInputs);

	logger.info("[StepIOContracts] Contract validation complete", {
		valid: validation.valid,
		errorCount: validation.errors.length,
		warningCount: validation.warnings.length,
		wiringCount: validation.wiring.length,
	});

	return {
		contracts: Array.from(contracts.entries()),
		validation,
	};
}

/**
 * Auto-wire steps based on inferred contracts.
 */
export async function autoWireStepsActivity(
	steps: TaskStep[],
): Promise<TaskStep[]> {
	const contracts = inferPlanContracts(steps);
	return autoWireSteps(steps, contracts);
}

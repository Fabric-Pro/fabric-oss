/**
 * Execution Wave Computation
 *
 * Groups steps into sequential waves using Kahn's topological sort.
 * Steps within the same wave have no mutual dependencies and can run in parallel.
 * Steps in wave N+1 depend on results from wave N.
 *
 * Fallback behaviour (when `dependsOn` is absent):
 *   - Steps sharing the same `parallelGroup` string are grouped together in one wave.
 *   - Steps without any `parallelGroup` each occupy their own wave (sequential).
 */

import type { TaskStep } from "./types/task.types";

/**
 * Computes execution waves for a list of steps using Kahn's topological sort.
 *
 * Resolution priority:
 *  1. `dependsOn` field — explicit DAG edges between step IDs.
 *  2. `parallelGroup` field — implicit grouping; steps with the same value share a wave.
 *  3. No dependency info — each step becomes a single-step wave (sequential fallback).
 *
 * Cycles and missing step-ID references are handled gracefully:
 *  - A reference to an unknown step ID is silently ignored (treated as satisfied).
 *  - If a topological cycle is detected, remaining cyclic steps are appended as a
 *    final wave in their original order to avoid an infinite loop.
 *
 * @returns An array of waves. Each wave is an array of steps that are safe to
 *          execute concurrently — all dependencies of every step in wave N are
 *          guaranteed to appear in waves 0 … N-1.
 */
export function computeExecutionWaves(steps: TaskStep[]): TaskStep[][] {
	if (steps.length === 0) {
		return [];
	}

	// Fast path: single step
	if (steps.length === 1) {
		return [steps];
	}

	const stepIds = new Set(steps.map((s) => s.id));

	// Determine whether any step carries explicit `dependsOn` information.
	const hasDependsOn = steps.some(
		(s) => s.dependsOn && s.dependsOn.length > 0,
	);

	// ------------------------------------------------------------------
	// Path A: DAG-based wave computation using `dependsOn`
	// ------------------------------------------------------------------
	if (hasDependsOn) {
		return computeWavesFromDependsOn(steps, stepIds);
	}

	// ------------------------------------------------------------------
	// Path B: parallelGroup-based grouping (fallback)
	// ------------------------------------------------------------------
	const hasParallelGroups = steps.some((s) => s.parallelGroup);
	if (hasParallelGroups) {
		return computeWavesFromParallelGroups(steps);
	}

	// ------------------------------------------------------------------
	// Path C: No dependency info — run every step sequentially
	// ------------------------------------------------------------------
	return steps.map((s) => [s]);
}

// =============================================================================
// Private helpers
// =============================================================================

/**
 * Builds waves from explicit `dependsOn` edges using Kahn's algorithm.
 */
function computeWavesFromDependsOn(
	steps: TaskStep[],
	stepIds: Set<string>,
): TaskStep[][] {
	// Map from step ID → step object for quick lookup
	const stepMap = new Map<string, TaskStep>(steps.map((s) => [s.id, s]));

	// Build in-degree map and adjacency list (dependency → dependents)
	const inDegree = new Map<string, number>();
	// dependents[A] = list of steps that depend on A
	const dependents = new Map<string, string[]>();

	for (const step of steps) {
		inDegree.set(step.id, 0);
		dependents.set(step.id, []);
	}

	for (const step of steps) {
		const deps = (step.dependsOn ?? []).filter(
			// Only count edges to known steps; ignore unresolved references
			(dep) => stepIds.has(dep),
		);
		inDegree.set(step.id, deps.length);
		for (const dep of deps) {
			dependents.get(dep)?.push(step.id);
		}
	}

	const waves: TaskStep[][] = [];
	const processed = new Set<string>();

	// Kahn's BFS
	while (processed.size < steps.length) {
		// Collect all steps with in-degree 0 that haven't been processed yet
		const wave: TaskStep[] = [];
		for (const [id, degree] of inDegree) {
			if (degree === 0 && !processed.has(id)) {
				const step = stepMap.get(id);
				if (step) {
					wave.push(step);
				}
			}
		}

		if (wave.length === 0) {
			// Cycle detected — append remaining steps as-is to avoid infinite loop
			const remaining = steps.filter((s) => !processed.has(s.id));
			if (remaining.length > 0) {
				waves.push(remaining);
			}
			break;
		}

		waves.push(wave);

		for (const step of wave) {
			processed.add(step.id);
			inDegree.delete(step.id);

			// Decrement in-degree of all steps that depended on this one
			for (const dependentId of dependents.get(step.id) ?? []) {
				const current = inDegree.get(dependentId) ?? 0;
				inDegree.set(dependentId, Math.max(0, current - 1));
			}
		}
	}

	return waves.filter((w) => w.length > 0);
}

/**
 * Groups steps into waves using `parallelGroup` strings.
 *
 * Groups with the same `parallelGroup` value are placed in the same wave.
 * Steps without a `parallelGroup` each get their own single-step wave,
 * preserving the sequential ordering the planner intended.
 *
 * Wave order follows the first appearance of each group/step in the original
 * step array to respect the planner's overall ordering intent.
 */
function computeWavesFromParallelGroups(steps: TaskStep[]): TaskStep[][] {
	const waves: TaskStep[][] = [];
	// Map from parallelGroup value → index in waves array
	const groupWaveIndex = new Map<string, number>();

	for (const step of steps) {
		if (step.parallelGroup) {
			const existing = groupWaveIndex.get(step.parallelGroup);
			if (existing !== undefined) {
				// Append to the existing wave for this group
				waves[existing].push(step);
			} else {
				// Create a new wave for this group
				groupWaveIndex.set(step.parallelGroup, waves.length);
				waves.push([step]);
			}
		} else {
			// No group — sequential, own wave
			waves.push([step]);
		}
	}

	return waves.filter((w) => w.length > 0);
}

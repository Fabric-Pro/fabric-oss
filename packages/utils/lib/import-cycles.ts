/**
 * Circular-import detection over a directed graph.
 *
 * Written for the PR review architecture lens (the architecture lens) and kept
 * dependency-free here so both the API and any future consumer can use it — and
 * so it can be tested exhaustively without a database or a model anywhere near
 * it.
 *
 * The whole point of computing this rather than asking a model: a cycle either
 * exists in the graph or it does not. There is no false-positive rate to
 * measure, no prompt to drift, and no judgement to trust — which is why the QA
 * lens's <20% bar does not apply to findings produced from here.
 */

/** One strongly-connected component of size > 1: a genuine import cycle. */
export interface ImportCycle {
	/** Member node keys, sorted, so the same cycle always reads the same way. */
	members: string[];
	/**
	 * A concrete path back to the start (`a → b → c → a`), for a person who has
	 * to go and break it. A component only tells you the members; this tells you
	 * an edge sequence that actually closes.
	 */
	path: string[];
}

/**
 * Every import cycle in the graph, via Tarjan's strongly-connected components.
 *
 * Tarjan rather than a naive DFS cycle-walk because a real dependency graph has
 * exponentially many distinct cycles through a single tangled component, and
 * reporting them all is noise: what a reader can act on is "these N modules form
 * a knot", once, plus one example path through it. Linear time, iterative, so a
 * deep graph cannot blow the stack.
 *
 * Self-loops (a file importing itself) are excluded — they are a parser artifact
 * or a re-export, never the architectural problem this looks for.
 */
export function findImportCycles(
	edges: Array<{ from: string; to: string }>,
): ImportCycle[] {
	const adjacency = new Map<string, string[]>();
	for (const { from, to } of edges) {
		if (from === to) {
			continue;
		}
		const list = adjacency.get(from);
		if (list) {
			list.push(to);
		} else {
			adjacency.set(from, [to]);
		}
		if (!adjacency.has(to)) {
			adjacency.set(to, []);
		}
	}

	let nextIndex = 0;
	const index = new Map<string, number>();
	const lowLink = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const components: string[][] = [];

	// Iterative Tarjan: each frame is a node plus how far through its successors
	// we have walked, which is what recursion would otherwise hold for us.
	for (const root of adjacency.keys()) {
		if (index.has(root)) {
			continue;
		}
		const frames: Array<{ node: string; next: number }> = [
			{ node: root, next: 0 },
		];
		index.set(root, nextIndex);
		lowLink.set(root, nextIndex);
		nextIndex++;
		stack.push(root);
		onStack.add(root);

		while (frames.length > 0) {
			const frame = frames[frames.length - 1];
			const successors = adjacency.get(frame.node) ?? [];

			if (frame.next < successors.length) {
				const next = successors[frame.next];
				frame.next++;
				if (!index.has(next)) {
					index.set(next, nextIndex);
					lowLink.set(next, nextIndex);
					nextIndex++;
					stack.push(next);
					onStack.add(next);
					frames.push({ node: next, next: 0 });
				} else if (onStack.has(next)) {
					lowLink.set(
						frame.node,
						Math.min(
							lowLink.get(frame.node) ?? 0,
							index.get(next) ?? 0,
						),
					);
				}
				continue;
			}

			frames.pop();
			const parent = frames[frames.length - 1];
			if (parent) {
				lowLink.set(
					parent.node,
					Math.min(
						lowLink.get(parent.node) ?? 0,
						lowLink.get(frame.node) ?? 0,
					),
				);
			}

			if (lowLink.get(frame.node) === index.get(frame.node)) {
				const component: string[] = [];
				let member: string | undefined;
				do {
					member = stack.pop();
					if (member === undefined) {
						break;
					}
					onStack.delete(member);
					component.push(member);
				} while (member !== frame.node);
				// Size 1 with no self-loop is just a node, not a cycle.
				if (component.length > 1) {
					components.push(component);
				}
			}
		}
	}

	return (
		components
			.map((component) => ({
				members: [...component].sort(),
				path: shortestCycleWithin(component, adjacency),
			}))
			// Stable order so a re-run does not reshuffle the finding list.
			.sort((a, b) => a.members[0].localeCompare(b.members[0]))
	);
}

/**
 * The shortest cycle back to a component's first member, by breadth-first search
 * restricted to that component.
 *
 * Shortest rather than the first one DFS happens to find: a 3-hop cycle inside a
 * 20-node knot is the one somebody can actually read and break, and the DFS path
 * through a tangle is arbitrary in a way that makes two runs look like two
 * different problems.
 */
function shortestCycleWithin(
	component: string[],
	adjacency: Map<string, string[]>,
): string[] {
	const inComponent = new Set(component);
	// Deterministic entry point, so the reported path is stable across runs.
	const start = [...component].sort()[0];
	const queue: string[][] = [[start]];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const path = queue.shift();
		if (!path) {
			break;
		}
		const tail = path[path.length - 1];
		for (const next of adjacency.get(tail) ?? []) {
			if (!inComponent.has(next)) {
				continue;
			}
			if (next === start) {
				return [...path, start];
			}
			if (seen.has(next)) {
				continue;
			}
			seen.add(next);
			queue.push([...path, next]);
		}
	}
	// Unreachable for a real SCC of size > 1, but a graph built from partial data
	// should degrade to "here are the members" rather than throw.
	return component;
}

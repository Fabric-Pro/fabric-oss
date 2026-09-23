"use client";

/**
 * One resolution of the gating matrix per project page (Fizzy #1930).
 *
 * ## Why a provider and not a hook each component calls
 *
 * Gating is not one component's concern — a project page can hold a banner, a
 * handful of badges and several gated buttons at once, and every one of them
 * wants the same answer. A hook that fetched per caller would issue a request
 * per gated control on every render of every tab, for a payload that is
 * identical each time. One query above them all, selected from by key, is the
 * only shape that stays honest as the number of gated surfaces grows.
 *
 * The read asks, in ONE request, for exactly the surfaces a project page
 * mounts — see {@link MOUNTED_SURFACES}. Not one request per surface, which is
 * the per-component fetching the provider exists to prevent; and not the whole
 * matrix either. The whole matrix included the Atlas gates, and resolving those
 * reaches the git provider over HTTP, may refresh a credential and can write an
 * audit row — on every project page load and after every mutation, for two
 * gates no page renders.
 *
 * ## Using a gated component without the provider is a bug, not a fallback
 *
 * It fails loudly in development. The tempting alternative — quietly fetching
 * on its own — produces exactly the N-requests-per-page behaviour above, and
 * produces it invisibly, which is how it would survive review.
 */

import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import {
	buildCapabilityGateView,
	type CapabilityGateView,
	type GateDestination,
} from "../../lib/capability-gate-view";
import { useCodebaseRetry } from "./codebase-retry";
import { type GateLink, gateLinkFor } from "./gate-destinations";
import {
	readSessionDismissals,
	sessionDismissalKey,
	writeSessionDismissals,
} from "./session-dismissals";

/**
 * How long a dismissal lasts.
 *
 * `session` is handled here and never sent: it lives in `sessionStorage` and
 * dies with the tab (see `session-dismissals.ts`). The other four are stored
 * server-side. First in the list because it is the lightest commitment.
 */
export type SnoozeDuration = "session" | "1d" | "7d" | "30d" | "forever";

export const SNOOZE_DURATIONS: readonly SnoozeDuration[] = [
	"session",
	"1d",
	"7d",
	"30d",
	"forever",
];

/**
 * The surfaces a project page mounts a gate on: the document dialog and a
 * document's auto-refresh control, the Context tab, the Security tab, the
 * newsletter settings, Settings → Knowledge's chat monitors, and the
 * Roadmap's entry points. Atlas is absent on purpose — it keeps its own
 * status UI, and its gates are the expensive ones to resolve. Settings is
 * cheap: its rules read rows only.
 */
const MOUNTED_SURFACES = [
	"documents",
	"context",
	"security",
	"release-notes",
	"roadmap",
	"settings",
] as const;

/**
 * How often to re-read while something is Processing.
 *
 * A gate only changes when project state does, and a finishing job changes it
 * without any mutation on this page — so without polling, "Indexing your
 * repository" stayed up until the window was refocused. Only while a gate is
 * waiting on a job: an idle page polls nothing.
 *
 * Waiting is read from the remedy as well as the state. A document generator
 * whose only source is the repository reports indexing as a soft block with a
 * WAIT remedy, so pasted text can still lift it — keyed on the state alone,
 * that banner never cleared when the index finished.
 */
const PROCESSING_REFETCH_MS = 5_000;

function isWaitingOnJob(gate: CapabilityGate): boolean {
	return gate.state === "PROCESSING" || gate.remedy === "WAIT";
}

interface CapabilityGatesValue {
	projectId: string;
	/**
	 * The feature flag, as the server reports it.
	 *
	 * False means render today's UI exactly: no banners, no badges, nothing
	 * disabled. The server sends no gates at all in that case, so every
	 * selector below already answers "nothing to show" — this is here so a
	 * surface can tell "off" from "still loading" when it needs to.
	 */
	enabled: boolean;
	isLoading: boolean;
	gates: ReadonlyMap<string, CapabilityGate>;
	/** How many warnings this viewer has silenced, for a restore affordance. */
	suppressedCount: number;
	/** Whether this viewer dismissed this gate's warning for the session. */
	isSessionDismissed: (gate: CapabilityGate) => boolean;
	/** Where a remedy button goes — one answer for every banner. */
	linkFor: (target: GateDestination) => GateLink | null;
	/** Re-index the repository a codebase gate names, or `undefined`. */
	codebaseRetryFor: (gate: CapabilityGate) => (() => void) | undefined;
	codebaseRetrying: boolean;
	suppress: (args: {
		capabilityKey: string;
		reasonKey: string;
		duration: SnoozeDuration;
	}) => void;
	/**
	 * Bring silenced warnings back.
	 *
	 * With no argument, every warning this viewer silenced on this project.
	 * With targets, only those — which is what a per-surface control wants:
	 * someone clicking "show dismissed warnings" above their documents has not
	 * asked to undo a dismissal they made on another tab.
	 */
	restore: (targets?: readonly RestoreTarget[]) => void;
	refetch: () => void;
}

/** One silenced warning, identified the way the restore procedure expects. */
export interface RestoreTarget {
	capabilityKey: string;
	reasonKey: string;
}

const CapabilityGatesContext = createContext<CapabilityGatesValue | null>(null);

export function CapabilityGatesProvider({
	projectId,
	children,
}: {
	projectId: string;
	children: ReactNode;
}) {
	const { organizationId, basePath } = useOrganizationContext();
	const codebaseRetry = useCodebaseRetry(projectId);
	const linkFor = useCallback(
		(target: GateDestination) =>
			gateLinkFor(target, { projectId, basePath }),
		[projectId, basePath],
	);

	/**
	 * The organization belongs in the key but NOT in the input.
	 *
	 * `tenantProtectedProcedure` resolves the tenant from the session itself,
	 * so passing one would be a caller-supplied tenant claim. It still has to
	 * key the cache: switching organization changes the answer completely, and
	 * a key that ignored it would serve the previous tenant's gates for a beat.
	 */
	const queryKey = useMemo(
		() => ["capability-gates", projectId, organizationId],
		[projectId, organizationId],
	);

	const { data, isLoading, refetch } = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.capabilities.gates({
				projectId,
				surfaces: [...MOUNTED_SURFACES],
			}),
		staleTime: 30_000,
		refetchInterval: (query) =>
			query.state.data?.gates.some(isWaitingOnJob)
				? PROCESSING_REFETCH_MS
				: false,
	});

	// Session dismissals: read synchronously on the first render, so a
	// dismissed warning never paints for a frame before disappearing, and
	// re-read if the project changes under the provider. The read is
	// storage-safe on the server and in a private window alike.
	const [sessionDismissed, setSessionDismissed] = useState<
		ReadonlySet<string>
	>(() => readSessionDismissals(projectId));
	const [dismissalsProjectId, setDismissalsProjectId] = useState(projectId);
	if (dismissalsProjectId !== projectId) {
		setDismissalsProjectId(projectId);
		setSessionDismissed(readSessionDismissals(projectId));
	}
	const updateSessionDismissed = useCallback(
		(update: (current: Set<string>) => void) => {
			setSessionDismissed((previous) => {
				const next = new Set(previous);
				update(next);
				writeSessionDismissals(projectId, next);
				return next;
			});
		},
		[projectId],
	);
	const isSessionDismissed = useCallback(
		(gate: CapabilityGate) =>
			gate.state === "WARNING" &&
			sessionDismissed.has(sessionDismissalKey(gate)),
		[sessionDismissed],
	);

	const gates = useMemo(() => {
		const map = new Map<string, CapabilityGate>();
		for (const gate of data?.gates ?? []) {
			map.set(gate.capabilityKey, gate);
		}
		return map;
	}, [data]);

	const suppressMutation = useMutation({
		mutationFn: (args: {
			capabilityKey: string;
			reasonKey: string;
			duration: Exclude<SnoozeDuration, "session">;
		}) =>
			orpcClient.capabilities.suppressWarning({
				projectId,
				capabilityKey: args.capabilityKey,
				reasonKey: args.reasonKey,
				duration: args.duration,
			}),
		/**
		 * Re-read on either outcome, and especially on failure.
		 *
		 * The server re-resolves the gate before storing anything and refuses
		 * when the warning has moved on since it was rendered. That refusal is
		 * not an error worth showing anybody — it means the screen is stale, and
		 * the fix is to show the current state rather than a message about a
		 * race the viewer did not cause.
		 */
		onSettled: () => {
			void refetch();
		},
	});

	const restoreMutation = useMutation({
		// One call for any number of warnings: the procedure takes the list
		// and rewrites the column once. With no list it clears the project.
		mutationFn: (targets?: readonly RestoreTarget[]) =>
			orpcClient.capabilities.restoreWarnings({
				projectId,
				...(targets ? { targets: [...targets] } : {}),
			}),
		onSettled: () => {
			void refetch();
		},
	});

	const suppress = useCallback(
		(args: {
			capabilityKey: string;
			reasonKey: string;
			duration: SnoozeDuration;
		}) => {
			if (args.duration === "session") {
				const gate = gates.get(args.capabilityKey);
				if (gate && gate.reasonKey === args.reasonKey) {
					updateSessionDismissed((keys) => {
						keys.add(sessionDismissalKey(gate));
					});
				}
				return;
			}
			suppressMutation.mutate({
				capabilityKey: args.capabilityKey,
				reasonKey: args.reasonKey,
				duration: args.duration,
			});
		},
		[gates, suppressMutation, updateSessionDismissed],
	);

	const restore = useCallback(
		(targets?: readonly RestoreTarget[]) => {
			// Session dismissals come back too, from the same control — the
			// viewer cannot tell the two kinds apart and should not have to.
			updateSessionDismissed((keys) => {
				for (const key of [...keys]) {
					const inScope =
						!targets ||
						targets.some((target) =>
							key.startsWith(
								`${target.capabilityKey}:${target.reasonKey}:`,
							),
						);
					if (inScope) {
						keys.delete(key);
					}
				}
			});
			// No targets means the viewer asked for everything back, and the
			// procedure clears the project. A scoped restore names its
			// warnings, all in one call — one call each raced on the column
			// they all rewrite and lost all but the last.
			const stored = targets?.filter(
				(target) => gates.get(target.capabilityKey)?.suppressed,
			);
			if (!stored || stored.length > 0) {
				restoreMutation.mutate(stored);
			}
		},
		[gates, restoreMutation, updateSessionDismissed],
	);

	const value = useMemo<CapabilityGatesValue>(
		() => ({
			projectId,
			enabled: data?.enabled ?? false,
			isLoading,
			gates,
			suppressedCount: [...gates.values()].filter(
				(g) => g.suppressed || isSessionDismissed(g),
			).length,
			isSessionDismissed,
			linkFor,
			codebaseRetryFor: codebaseRetry.retryFor,
			codebaseRetrying: codebaseRetry.isRetrying,
			suppress,
			restore,
			refetch: () => {
				void refetch();
			},
		}),
		[
			projectId,
			data,
			isLoading,
			gates,
			isSessionDismissed,
			linkFor,
			codebaseRetry.retryFor,
			codebaseRetry.isRetrying,
			suppress,
			restore,
			refetch,
		],
	);

	return createElement(CapabilityGatesContext.Provider, { value }, children);
}

const MISSING_PROVIDER =
	"A capability-gated component was rendered without <CapabilityGatesProvider>. " +
	"Wrap the project page in one — gates are resolved once per page and shared, " +
	"so a component must never fetch its own.";

/**
 * The shared gating state.
 *
 * Throws in **development** when there is no provider, so a wiring mistake is
 * impossible to miss the first time the page is opened. A silent fallback there
 * would let an unwrapped surface render as though nothing were gated, which
 * looks correct on screen and is wrong everywhere it matters.
 *
 * It degrades instead in production and under test, and the test half is a
 * deliberate reversal (Fizzy #1930). Throwing under test sounds stricter and is
 * worse: the suites for every gated page — the security page, the document
 * dialog, the contexts list — mock `@tanstack/react-query` wholesale to avoid
 * standing up a QueryClient, so the provider cannot run inside them at all.
 * Wrapping them would mean un-mocking react-query in a dozen unrelated files,
 * which makes gating a surface expensive enough that nobody would, and an
 * unmounted gate is a worse outcome than an unasserted one.
 *
 * The guarantee lives where it belongs instead: `CapabilityGatesProvider` is
 * mounted once in the project layout, above every gated tab, and a test on that
 * layout pins it. One structural check beats a throw repeated at each leaf.
 */
export function useCapabilityGates(): CapabilityGatesValue {
	const context = useContext(CapabilityGatesContext);
	if (context === null) {
		if (process.env.NODE_ENV === "development") {
			throw new Error(MISSING_PROVIDER);
		}
		return EMPTY_VALUE;
	}
	return context;
}

const EMPTY_VALUE: CapabilityGatesValue = {
	projectId: "",
	enabled: false,
	isLoading: false,
	gates: new Map(),
	suppressedCount: 0,
	isSessionDismissed: () => false,
	linkFor: () => null,
	codebaseRetryFor: () => undefined,
	codebaseRetrying: false,
	suppress: () => {},
	restore: () => {},
	refetch: () => {},
};

export interface CapabilityGateSelection {
	gate: CapabilityGate | null;
	view: CapabilityGateView | null;
	/** Whether the gated action must be disabled. False while loading and when the flag is off. */
	blocked: boolean;
	/**
	 * Whether the action must leave the page entirely — the server resolved
	 * `HIDDEN` because there is nothing for it to act on. False while loading
	 * and when the flag is off, so the action shows and its own door refuses.
	 */
	hidden: boolean;
}

/**
 * One capability's gate, ready to render.
 *
 * Every "nothing is known" case — the flag is off, the read is still in
 * flight, the matrix has no rule for this key — resolves to the same harmless
 * answer: no view, not blocked. That is deliberate. A gate that defaulted to
 * blocking would disable working buttons for the width of a request on every
 * page load, and would disable them permanently wherever the flag is off, which
 * is the exact opposite of a rollback lever.
 *
 * `hidden` is the one verdict a banner cannot express: `HIDDEN` removes the
 * action rather than disabling it, so it builds no view and the surface reads
 * the boolean to leave the action out. The same "nothing is known" rule holds —
 * an absent gate is never hidden.
 */
export function useCapabilityGate(
	capabilityKey: string,
): CapabilityGateSelection {
	const { gates, isSessionDismissed } = useCapabilityGates();
	const gate = gates.get(capabilityKey) ?? null;
	const dismissedForSession = gate !== null && isSessionDismissed(gate);

	return useMemo(() => {
		if (gate === null) {
			return { gate: null, view: null, blocked: false, hidden: false };
		}
		const view = buildCapabilityGateView(gate, dismissedForSession);
		return {
			gate,
			view,
			blocked: view?.blocksAction ?? false,
			hidden: gate.state === "HIDDEN",
		};
	}, [gate, dismissedForSession]);
}

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
 * The read deliberately asks for the **whole** matrix rather than passing the
 * procedure's `surface` filter. Narrowing per surface reads like an
 * optimisation and is the opposite of one here: a page showing two surfaces
 * would issue two requests for overlapping data, which is precisely the
 * per-component fetching the provider exists to prevent. The matrix is small
 * and resolves in a fixed number of aggregate queries server-side.
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
} from "react";
import {
	buildCapabilityGateView,
	type CapabilityGateView,
} from "../../lib/capability-gate-view";

/**
 * How long a dismissal lasts.
 *
 * `session` is absent on purpose. The shared constant in the API package still
 * lists it, but the write path throws on it and the procedure's input schema
 * refuses it — a control built from that constant would ship a button that
 * always 400s. A session-length dismissal is client state that dies with the
 * tab; it never becomes a stored row.
 */
export type SnoozeDuration = "1d" | "7d" | "30d" | "forever";

export const SNOOZE_DURATIONS: readonly SnoozeDuration[] = [
	"1d",
	"7d",
	"30d",
	"forever",
];

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
	const { organizationId } = useOrganizationContext();

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
		queryFn: () => orpcClient.capabilities.gates({ projectId }),
		staleTime: 30_000,
	});

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
			duration: SnoozeDuration;
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
		// Both fields or neither: the procedure targets one warning only when it
		// is given a capability AND a reason, and falls back to clearing the
		// whole project otherwise.
		mutationFn: (target?: RestoreTarget) =>
			orpcClient.capabilities.restoreWarnings({
				projectId,
				...(target ?? {}),
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
		}) => suppressMutation.mutate(args),
		[suppressMutation],
	);

	const restore = useCallback(
		(targets?: readonly RestoreTarget[]) => {
			// No targets means the viewer asked for everything back, and the
			// procedure clears the project in one call.
			if (!targets) {
				restoreMutation.mutate(undefined);
				return;
			}
			// A scoped restore is one call per warning. There is no bulk form on
			// the procedure, and the alternative — clearing the project because
			// the scoped set happens to be everything on this surface — would
			// silently undo dismissals made elsewhere.
			for (const target of targets) {
				restoreMutation.mutate(target);
			}
		},
		[restoreMutation],
	);

	const value = useMemo<CapabilityGatesValue>(
		() => ({
			projectId,
			enabled: data?.enabled ?? false,
			isLoading,
			gates,
			suppressedCount: [...gates.values()].filter((g) => g.suppressed)
				.length,
			suppress,
			restore,
			refetch: () => {
				void refetch();
			},
		}),
		[projectId, data, isLoading, gates, suppress, restore, refetch],
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
	suppress: () => {},
	restore: () => {},
	refetch: () => {},
};

export interface CapabilityGateSelection {
	gate: CapabilityGate | null;
	view: CapabilityGateView | null;
	/** Whether the gated action must be disabled. False while loading and when the flag is off. */
	blocked: boolean;
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
 * There is no `hidden` verdict. `HIDDEN` would mean removing the action from
 * the page rather than disabling it, no rule emits it today, and no surface had
 * anywhere to act on it — so carrying the boolean would have been a field with
 * no reader. See the note in `capability-gate-view.ts` for what the first rule
 * to emit it will need to add.
 */
export function useCapabilityGate(
	capabilityKey: string,
): CapabilityGateSelection {
	const { gates } = useCapabilityGates();
	const gate = gates.get(capabilityKey) ?? null;

	return useMemo(() => {
		if (gate === null) {
			return { gate: null, view: null, blocked: false };
		}
		const view = buildCapabilityGateView(gate);
		return { gate, view, blocked: view?.blocksAction ?? false };
	}, [gate]);
}

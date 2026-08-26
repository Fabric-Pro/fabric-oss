"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { seedOrganizationGuestFlag } from "./organization-guest-store";

/**
 * Server-seeded guest flag for the active organization.
 *
 * `undefined` = no provider above (personal context, or a tree rendered
 * outside the org layout) — consumers must fall back to client-side
 * detection. A present value is authoritative: it was computed by
 * `isGuestInOrg()` in the org layout's server render, so guests get the
 * personal-style shell on the FIRST client render with no flash and no
 * follow-up `organizations.isGuest` request.
 */
const OrganizationGuestContext = createContext<
	{ isGuest: boolean } | undefined
>(undefined);

export function OrganizationGuestProvider({
	organizationSlug,
	isGuest,
	children,
}: {
	organizationSlug: string;
	isGuest: boolean;
	children: ReactNode;
}) {
	// Mirror into the module store during render (browser-only inside the
	// helper; idempotent, so StrictMode double-renders and discarded
	// concurrent renders are harmless). Must happen in the render phase:
	// `ActiveOrganizationProvider` — mounted ABOVE this provider, so it
	// cannot read this context — fires its org query in a passive effect,
	// and render-phase work always commits before passive effects run.
	seedOrganizationGuestFlag(organizationSlug, isGuest);

	const value = useMemo(() => ({ isGuest }), [isGuest]);

	return (
		<OrganizationGuestContext.Provider value={value}>
			{children}
		</OrganizationGuestContext.Provider>
	);
}

/**
 * Read the server-seeded guest flag from context.
 * Returns `undefined` when no org layout has seeded a value (personal
 * context or non-org trees) — callers fall back to the oRPC query.
 */
export function useSeededGuestFlag(): boolean | undefined {
	return useContext(OrganizationGuestContext)?.isGuest;
}

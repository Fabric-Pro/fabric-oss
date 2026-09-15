/**
 * Public customer outcomes page (plan Slice 8).
 *
 * Token-scoped and read-only, mirroring /share/frame/[token]. The token is
 * the whole authorization: an unknown or revoked token is a 404. Data comes
 * from the same restricted projection `outcomes.getByToken` serves
 * (`getCustomerOutcomesByToken`), called in-process because apps/web does
 * not depend on `@orpc/server` for `call()`.
 */
import { getCustomerOutcomesByToken } from "@repo/api/modules/outcomes/lib/customer-outcomes";
import { CustomerOutcomesView } from "@saas/projects/components/outcomes/CustomerOutcomesView";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

export const dynamic = "force-dynamic";

// Deduplicate the lookup between generateMetadata and the page render.
const loadOutcomes = cache((token: string) =>
	getCustomerOutcomesByToken(token),
);

export async function generateMetadata({
	params,
}: {
	params: Promise<{ token: string }>;
}): Promise<Metadata> {
	const { token } = await params;
	const outcomes = await loadOutcomes(token);
	return {
		title: outcomes ? `${outcomes.projectName} — Outcomes` : "Outcomes",
		robots: { index: false, follow: false },
	};
}

export default async function SharedOutcomesPage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await params;
	const outcomes = await loadOutcomes(token);
	if (!outcomes) {
		notFound();
	}
	return (
		<main className="min-h-screen bg-background">
			<CustomerOutcomesView outcomes={outcomes} />
		</main>
	);
}

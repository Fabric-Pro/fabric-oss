import type { Metadata } from "next";
import { ConfirmSubscription } from "./ConfirmSubscription";

// Transactional page: keep out of search indexes, and never leak the token via
// the Referer header to any third-party resource the page might load.
export const metadata: Metadata = {
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export default async function NewsletterConfirmPage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await params;
	return <ConfirmSubscription token={token} />;
}

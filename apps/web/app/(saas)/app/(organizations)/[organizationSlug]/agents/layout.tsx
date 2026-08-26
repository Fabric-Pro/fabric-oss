import type { PropsWithChildren } from "react";

export default function OrganizationAgentsLayout({
	children,
}: PropsWithChildren) {
	// Parent organization layout already provides AppWrapper
	return <>{children}</>;
}

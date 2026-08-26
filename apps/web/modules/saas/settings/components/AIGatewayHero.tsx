"use client";

import { PageHeader } from "@saas/shared/components/PageHeader";
import { Button } from "@ui/components/button";
import { BookOpenIcon } from "lucide-react";
import Link from "next/link";

export function AIGatewayHero() {
	return (
		<PageHeader
			label="AI infrastructure"
			title="Model Configuration"
			description="Connect AI providers and credentials to enable agents, Nexus, document generation, and workflows."
			actions={
				<Button variant="outline" asChild className="gap-2">
					<Link
						href="https://sdk.vercel.ai/providers/ai-sdk-providers"
						target="_blank"
					>
						<BookOpenIcon className="size-4" />
						Browse providers
					</Link>
				</Button>
			}
		/>
	);
}

"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { useFormatter, useTranslations } from "next-intl";

export function OrganizationTotals() {
	const t = useTranslations("admin.organizations.overview");
	const format = useFormatter();
	const { data, isPending, isError } = useQuery(
		orpc.admin.hostedAdoption.counts.queryOptions(),
	);
	return (
		<section aria-label={t("totals")}>
			{isError ? (
				<p role="alert" className="text-destructive">
					{t("error")}
				</p>
			) : (
				<div className="grid gap-4 sm:grid-cols-3">
					{(
						[
							["organizations", t("organizations")],
							["projects", t("projects")],
							["users", t("users")],
						] as const
					).map(([key, label]) => (
						<Card key={key}>
							<CardHeader>
								<h2 className="font-medium text-base leading-none">
									{label}
								</h2>
							</CardHeader>
							<CardContent>
								<div>
									{isPending ? (
										// biome-ignore lint/a11y/useSemanticElements: announces loading rather than a calculated output.
										<div role="status">
											<span className="sr-only">
												{t("loading", { label })}
											</span>
											<Skeleton
												className="h-8 w-20"
												aria-hidden="true"
											/>
										</div>
									) : (
										<span className="text-3xl font-semibold">
											{format.number(data?.[key] ?? 0)}
										</span>
									)}
								</div>
								<p className="text-sm text-muted-foreground">
									{t(`${key}Hint`)}
								</p>
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</section>
	);
}

"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { SkillViewer } from "./SkillViewer";

interface SkillViewLoaderProps {
	skillId: string;
}

export function SkillViewLoader({ skillId }: SkillViewLoaderProps) {
	const { data, isLoading, error } = useQuery(
		orpc.skills.get.queryOptions({
			input: { id: skillId },
		}),
	);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		);
	}

	if (error || !data?.skill) {
		return (
			<div className="text-center py-12">
				<p className="text-muted-foreground">
					{error?.message || "Skill not found"}
				</p>
			</div>
		);
	}

	return <SkillViewer skill={data.skill} />;
}

import { getRecentSlackMessagesProcedure } from "./procedures/get-recent-slack-messages";
import { getRecentTeamsMessagesProcedure } from "./procedures/get-recent-teams-messages";
import { getSlackContextProcedure } from "./procedures/get-slack-context";
import { githubOAuthProcedures } from "./procedures/github-oauth";
import { gitlabOAuthProcedures } from "./procedures/gitlab-oauth";
import { genericOAuthProcedures } from "./procedures/oauth";
import { getTeamsEventsStatusProcedure } from "./procedures/teams-events";

export const integrationsRouter = {
	github: githubOAuthProcedures,
	gitlab: gitlabOAuthProcedures,
	oauth: genericOAuthProcedures,
	slack: {
		getContext: getSlackContextProcedure,
		getRecentMessages: getRecentSlackMessagesProcedure,
	},
	teams: {
		getRecentMessages: getRecentTeamsMessagesProcedure,
		getEventsStatus: getTeamsEventsStatusProcedure,
	},
};

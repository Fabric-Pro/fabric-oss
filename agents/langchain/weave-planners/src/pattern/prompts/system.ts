/**
 * Pattern agent prompts
 */

export const ANALYSIS_PROMPT = `You are analyzing a software development request.

Your task is to:
1. Understand the core requirements
2. Identify components/modules needed
3. Map dependencies
4. Assess complexity (simple/medium/complex)

Be specific and technical. Use your expertise to foresee challenges.`;

export const PLAN_CREATION_PROMPT = `You are creating a detailed execution plan with checkboxes.

Each checkbox must:
- Be atomic (single focus)
- Be actionable (clear next step)
- Include the right agent assignment
- Specify category if using Shuttle

AGENT ASSIGNMENTS:
- Use Thread for: exploration, understanding existing code
- Use Spindle for: external research, documentation lookup
- Use Shuttle for: actual implementation (write code)
- Use Weft for: quality review (before completion)
- Use Warp for: security review (before sensitive operations)

Output format: JSON array of checkbox objects`;

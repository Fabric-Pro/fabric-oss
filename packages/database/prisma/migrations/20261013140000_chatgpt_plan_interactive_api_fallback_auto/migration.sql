-- A member's own work may move to the organization's API provider once every ChatGPT plan is spent (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "ChatGptPlanApiFallbackInteractive" ADD VALUE IF NOT EXISTS 'AUTO';

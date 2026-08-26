-- Add the FABRIC_NATIVE value to the AgentFramework enum so the canonical
-- workspace assistant can be seeded as a system agent.
ALTER TYPE "AgentFramework" ADD VALUE IF NOT EXISTS 'FABRIC_NATIVE';

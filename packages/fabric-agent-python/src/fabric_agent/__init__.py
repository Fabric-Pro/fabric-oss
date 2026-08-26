"""
Fabric Agent Python Library

Multi-tenant runtime utilities for Fabric Python agents.
Provides model resolution, tenant context management, and API key authentication.
"""

from .tenant import TenantContext, TenantModelConfig
from .resolver import ModelResolver, resolve_model_config
from .models import create_model_from_config, get_agent_model

__version__ = "0.1.0"

__all__ = [
    "TenantContext",
    "TenantModelConfig",
    "ModelResolver",
    "resolve_model_config",
    "create_model_from_config",
    "get_agent_model",
]


"use client";

import { createContext } from "react";

// RenderMessage gates row loading flags on isCurrentMessage; trace owners need the run flag.
export const AssistantRunContext = createContext(false);

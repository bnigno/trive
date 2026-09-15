import type { BadgeTone } from "@/components/ui/badge";
import type { RunStatus, StopStatus } from "@/core/delivery/state";

export const RUN_TONE: Record<RunStatus, BadgeTone> = {
  ready: "info",
  en_route: "success",
  finished: "neutral",
  canceled: "danger",
};

export const STOP_TONE: Record<StopStatus, BadgeTone> = {
  pending: "info",
  delivered: "success",
  failed: "danger",
  canceled: "neutral",
};

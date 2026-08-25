import { z } from "zod";

const adapterModeSchema = z.enum(["fake", "real"]);

export type AdapterMode = z.infer<typeof adapterModeSchema>;

export function getAdapterMode(): AdapterMode {
  return adapterModeSchema.parse(process.env.ADAPTER_MODE ?? "fake");
}

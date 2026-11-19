import { bindAdapter, type BoundAdapter } from "@beachside/adapter";
import type { z } from "zod";
import { upstashBoxAdapter } from "./adapter";

export {
  createUpstashBoxAdapter,
  upstashBoxAdapter,
  type UpstashBoxAdapterOptions,
} from "./adapter";

export type UpstashBoxOptions = z.input<typeof upstashBoxAdapter.credentials> &
  z.input<typeof upstashBoxAdapter.config>;

export function upstashBox(options: UpstashBoxOptions): BoundAdapter {
  const { apiKey, ...config } = options;

  return bindAdapter(upstashBoxAdapter, config, { apiKey });
}

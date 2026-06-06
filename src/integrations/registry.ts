/**
 * Collects integrations and projects them into the two things the rest of the
 * app consumes: persona capability lines and a deduplicated tool array for
 * `createAgentSession({ customTools })`.
 */
import type { CustomTool, Integration, IntegrationContext } from "./types.ts";

export class IntegrationRegistry {
  private readonly integrations = new Map<string, Integration>();

  /** Register one integration. Last registration of a given name wins. */
  register(integration: Integration): this {
    this.integrations.set(integration.name, integration);
    return this;
  }

  /** Register many at once. */
  registerAll(integrations: Iterable<Integration>): this {
    for (const integration of integrations) this.register(integration);
    return this;
  }

  get size(): number {
    return this.integrations.size;
  }

  /** Capability lines for the persona, in registration order. */
  capabilities(): string[] {
    const lines: string[] = [];
    for (const integration of this.integrations.values()) {
      if (integration.capability) lines.push(integration.capability);
    }
    return lines;
  }

  /**
   * Build every integration's tools into one array. Tool names must be globally
   * unique (pi rejects duplicates at registration); we surface a clear error
   * here instead of letting it fail deep in session setup.
   */
  async buildTools(ctx: IntegrationContext): Promise<CustomTool[]> {
    const byToolName = new Map<string, string>(); // toolName -> integration name
    const tools: CustomTool[] = [];

    for (const integration of this.integrations.values()) {
      const built = await integration.tools({ ...ctx, logger: ctx.logger.child(integration.name) });
      for (const tool of built) {
        const owner = byToolName.get(tool.name);
        if (owner) {
          throw new Error(
            `Tool name collision: "${tool.name}" is defined by both "${owner}" and "${integration.name}".`,
          );
        }
        byToolName.set(tool.name, integration.name);
        tools.push(tool);
      }
      if (built.length > 0) {
        ctx.logger.info("integration loaded", { name: integration.name, tools: built.map((t) => t.name) });
      }
    }

    return tools;
  }
}

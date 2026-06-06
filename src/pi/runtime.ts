/**
 * PiRuntime — the bridge to pi's *own* authentication and model systems.
 *
 * This is the whole point of "use pi's auth": we never touch raw API keys here.
 * `discoverAuthStorage()` loads pi's credential vault (local `~/.omp/agent` or a
 * remote auth-broker when `OMP_AUTH_BROKER_URL` is set), and `ModelRegistry`
 * resolves which models that vault can actually talk to. One runtime is shared
 * by every conversation.
 */
import {
  type AuthStorage,
  type CreateAgentSessionOptions,
  discoverAuthStorage,
  ModelRegistry,
} from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";

// The SDK does not re-export `ConfiguredThinkingLevel` from its root, so we name
// the selector through the public options interface that actually consumes it.
type ThinkingSelector = CreateAgentSessionOptions["thinkingLevel"];

/** Models tried, in order, when the operator does not pin POKE_MODEL. */
const PREFERRED_MODELS = [
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-0",
  "anthropic/claude-3-5-sonnet-20241022",
] as const;

function describe(model: Model): string {
  return `${model.provider}/${model.id}`;
}

export class PiRuntime {
  private constructor(
    readonly authStorage: AuthStorage,
    readonly modelRegistry: ModelRegistry,
    readonly model: Model,
    readonly thinkingLevel: ThinkingSelector,
  ) {}

  /**
   * Boot pi's auth + model discovery and lock in the model the bot will run on.
   * Throws with an actionable message when no authenticated model is usable.
   */
  static async create(config: Config, logger: Logger): Promise<PiRuntime> {
    const authStorage = await discoverAuthStorage(config.agentDir);
    const modelRegistry = new ModelRegistry(authStorage);
    await modelRegistry.refresh();

    const available = modelRegistry.getAvailable();
    if (available.length === 0) {
      throw new Error(
        "pi has no authenticated models. Log in first (e.g. `omp auth-broker login anthropic` " +
          "or your normal omp/pi login) so credentials exist in pi's vault.",
      );
    }

    const model = PiRuntime.resolveModel(config.model, available, modelRegistry);
    logger.info("pi runtime ready", {
      model: describe(model),
      oauth: modelRegistry.isUsingOAuth(model),
      availableCount: available.length,
      thinking: config.thinking,
    });

    // config.thinking is validated to one of the selector's string values; the
    // SDK types it via a const enum, so this single boundary cast is exact.
    return new PiRuntime(authStorage, modelRegistry, model, config.thinking as ThinkingSelector);
  }

  private static resolveModel(
    requested: string | undefined,
    available: Model[],
    registry: ModelRegistry,
  ): Model {
    if (requested) {
      const slash = requested.indexOf("/");
      if (slash <= 0 || slash === requested.length - 1) {
        throw new Error(`POKE_MODEL="${requested}" must be "provider/model-id" (e.g. anthropic/claude-sonnet-4-5).`);
      }
      const provider = requested.slice(0, slash);
      const id = requested.slice(slash + 1);
      const found = registry.find(provider, id);
      if (!found || !registry.hasConfiguredAuth(found)) {
        const sample = available.slice(0, 12).map(describe).join(", ");
        throw new Error(
          `POKE_MODEL="${requested}" is not available with your pi credentials. ` +
            `Authenticated models include: ${sample}${available.length > 12 ? ", …" : ""}.`,
        );
      }
      return found;
    }

    for (const selector of PREFERRED_MODELS) {
      const match = available.find((m) => describe(m) === selector);
      if (match) return match;
    }
    // No preferred model authenticated — fall back to whatever pi can use.
    return available[0]!;
  }
}

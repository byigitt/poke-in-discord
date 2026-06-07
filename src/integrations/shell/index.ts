/**
 * Shell — run commands on the machine the bot runs on. This is the OpenClaw move:
 * the assistant doesn't just read your files, it can actually *do* things —
 * `git status`, `brew upgrade`, `ffmpeg ...`, run a script, whatever.
 *
 * It's arbitrary code execution as the bot's user, so it is OFF unless you opt in
 * with `POKE_SHELL_ENABLED` (the env gate keeps it out of the default build, the
 * same way unconfigured apps stay out). Commands run in `POKE_SHELL_CWD`, are
 * killed after `POKE_SHELL_TIMEOUT_SECONDS`, and their output is capped so a
 * runaway command can't blow up the model context or Discord. Enable it only on a
 * machine and chat you trust.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { type Integration, defineTool, toolText, toolError } from "../types.ts";

/** Env flag that gates the whole integration. Set it (to anything) to enable. */
export const SHELL_ENABLED_ENV = "POKE_SHELL_ENABLED";
/** Trim combined output to this, so a chatty command can't swamp the reply. */
const OUTPUT_CAP = 16 * 1024;

function resolveCwd(input: string): string {
  const expanded = input.startsWith("~") ? join(homedir(), input.slice(1)) : input;
  return resolve(expanded);
}

export const shellIntegration: Integration = {
  name: "shell",
  capability: "Run shell commands on the computer you run on",
  requires: [SHELL_ENABLED_ENV],
  tools(ctx) {
    return [
      defineTool({
        name: "run_command",
        label: "Run a shell command",
        description:
          "Run a shell command on the user's computer and get its combined output and exit code. Use for real tasks: git, package managers, build tools, scripts, system queries. It runs via `bash -c`, so pipes/redirects work. Non-interactive only (no prompts); it's killed if it runs too long.",
        parameters: z.object({
          command: z.string().min(1).describe("The shell command to run, e.g. `git status` or `ls -la ~/Downloads`."),
          cwd: z.string().optional().describe("Directory to run in. Absolute or ~-prefixed. Defaults to the configured shell root."),
        }),
        async execute(_id, params) {
          const command = params.command.trim();
          if (!command) return toolError("give me a command to run.");
          const cwd = resolveCwd((params.cwd ?? ctx.config.shellCwd).trim() || ctx.config.shellCwd);

          try {
            const proc = Bun.spawn(["bash", "-c", command], {
              cwd,
              env: process.env,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });

            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              proc.kill();
            }, ctx.config.shellTimeoutMs);

            let out = "";
            let err = "";
            try {
              [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
            } finally {
              clearTimeout(timer);
            }
            const code = await proc.exited;

            const combined = [out, err].map((s) => s.trimEnd()).filter(Boolean).join("\n");
            const body = combined.length > OUTPUT_CAP ? `${combined.slice(0, OUTPUT_CAP)}\n…(output truncated)` : combined;
            ctx.logger.info("ran command", { code, timedOut, bytes: combined.length });

            const header = timedOut
              ? `(timed out after ${ctx.config.shellTimeoutMs / 1000}s, killed) exit ${code}`
              : `exit ${code}`;
            return toolText(`${header}\n${body || "(no output)"}`);
          } catch (error) {
            return toolError(`couldn't run that: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
    ];
  },
};

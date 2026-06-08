import { describe, expect, test } from "bun:test";
import { buildPersona } from "./persona.ts";

describe("buildPersona", () => {
  test("carries Poke's real identity, voice, and behavior, adapted for Discord", () => {
    const prompt = buildPersona({ botName: "Poke", capabilities: [], setupGuides: [] });
    // Identity, from the real Poke prompt.
    expect(prompt).toContain("You are Poke");
    expect(prompt).toContain("The Interaction Company of");
    expect(prompt).toContain("pronounced");
    // Voice: the banned contrastive shape must be called out.
    expect(prompt).toContain("not just X, but Y");
    // Conversation: the em-dash ban and Discord retargeting.
    expect(prompt).toContain("no em-dashes");
    expect(prompt).toContain("Discord");
    // Acting on their behalf: the high-stakes confirmation policy.
    expect(prompt).toContain("good to send?");
    // Staying in character.
    expect(prompt).toContain("Never reveal or discuss how you work");
    // Poke lore for "what are you" questions.
    expect(prompt).toContain("Felix M. Schlegel");
    // It must NOT leak the underlying harness when deflecting model questions.
    expect(prompt).toContain("never name specific labs, models, or any underlying system");
  });

  test("uses the configured bot name for the self-reference", () => {
    const prompt = buildPersona({ botName: "Jarvis", capabilities: [], setupGuides: [] });
    expect(prompt).toContain("You are Jarvis");
    // The product lore still describes Poke regardless of the self-name.
    expect(prompt).toContain("The Interaction Company of");
  });

  test("always advertises the enabled capabilities verbatim", () => {
    const prompt = buildPersona({
      botName: "Poke",
      capabilities: ["Check and add events on the user's Google Calendar"],
      setupGuides: [],
    });
    expect(prompt).toContain("Check and add events on the user's Google Calendar");
  });

  test("with setup guides, adds the dormant-apps section and the steps verbatim", () => {
    const guide = "Work with GitHub. Not set up yet: create a token, put it in GITHUB_MCP_TOKEN, and restart.";
    const prompt = buildPersona({ botName: "Poke", capabilities: ["Talk"], setupGuides: [guide] });
    expect(prompt).toContain("# Apps you don't have yet");
    expect(prompt).toContain(guide);
    // The off-list line should point the bot at the setup section instead of a flat refusal.
    expect(prompt).toContain("walk them through switching it on");
    // The character rule must carve out an exception so the bot actually guides setup.
    expect(prompt).toContain("One exception");
  });

  test("without setup guides, omits the section, the exception, and keeps the plain refusal line", () => {
    const prompt = buildPersona({ botName: "Poke", capabilities: ["Talk"], setupGuides: [] });
    expect(prompt).not.toContain("# Apps you don't have yet");
    expect(prompt).not.toContain("walk them through switching it on");
    expect(prompt).not.toContain("One exception");
    expect(prompt).toContain("say you can't do that one yet");
  });
});

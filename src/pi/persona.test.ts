import { describe, expect, test } from "bun:test";
import { buildPersona } from "./persona.ts";

describe("buildPersona", () => {
  test("always advertises the enabled capabilities", () => {
    const prompt = buildPersona({
      botName: "Poke",
      capabilities: ["Check and add events on the user's Google Calendar"],
      setupGuides: [],
    });
    expect(prompt).toContain("Check and add events on the user's Google Calendar");
    expect(prompt).toContain("You are Poke");
  });

  test("with setup guides, adds the dormant-apps section and the steps verbatim", () => {
    const guide = "Work with GitHub. Not set up yet — create a token, put it in GITHUB_MCP_TOKEN, and restart.";
    const prompt = buildPersona({ botName: "Poke", capabilities: ["Talk"], setupGuides: [guide] });
    expect(prompt).toContain("# Apps you don't have yet");
    expect(prompt).toContain(guide);
    // The off-list line should point the bot at the setup section instead of a flat refusal.
    expect(prompt).toContain("walk them through switching it on");
    // The character rule must carve out an exception so the bot actually guides setup.
    expect(prompt).toContain("One exception");
  });

  test("without setup guides, omits the section and keeps the plain refusal line", () => {
    const prompt = buildPersona({ botName: "Poke", capabilities: ["Talk"], setupGuides: [] });
    expect(prompt).not.toContain("# Apps you don't have yet");
    expect(prompt).not.toContain("walk them through switching it on");
    expect(prompt).toContain("say you can't do that one yet");
  });
});

import { describe, expect, test } from "bun:test";
import { ReplyOutbox } from "./outbox.ts";

describe("ReplyOutbox", () => {
  test("stages files and drains them in order for a session", () => {
    const outbox = new ReplyOutbox();
    outbox.stage("s1", { path: "/a.txt", name: "a.txt" });
    outbox.stage("s1", { path: "/b.txt", name: "b.txt" });
    expect(outbox.drain("s1").map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  test("drain clears the bucket, so a second drain is empty", () => {
    const outbox = new ReplyOutbox();
    outbox.stage("s1", { path: "/a.txt", name: "a.txt" });
    outbox.drain("s1");
    expect(outbox.drain("s1")).toEqual([]);
  });

  test("keeps separate sessions isolated", () => {
    const outbox = new ReplyOutbox();
    outbox.stage("s1", { path: "/a.txt", name: "a.txt" });
    outbox.stage("s2", { path: "/b.txt", name: "b.txt" });
    expect(outbox.drain("s2").map((f) => f.name)).toEqual(["b.txt"]);
    // Draining s2 must not disturb s1.
    expect(outbox.drain("s1").map((f) => f.name)).toEqual(["a.txt"]);
  });

  test("draining an unknown session yields an empty array, never undefined", () => {
    expect(new ReplyOutbox().drain("never-staged")).toEqual([]);
  });
});

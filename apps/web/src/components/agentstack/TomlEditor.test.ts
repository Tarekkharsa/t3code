import { describe, expect, it } from "vite-plus/test";

import { tokenizeTomlLine } from "./TomlEditor";

const kinds = (line: string) => tokenizeTomlLine(line).map((t) => t.kind);
const rejoin = (line: string) =>
  tokenizeTomlLine(line)
    .map((t) => t.text)
    .join("");

describe("tokenizeTomlLine", () => {
  it("never loses or invents a character", () => {
    // The mirror is drawn from these runs and sits under a transparent
    // textarea, so any drift between the two shows as colour sliding off the
    // text. Round-tripping is the property that prevents it.
    for (const line of [
      'command = "/usr/bin/node"',
      "[servers.agentstack.extra.codex]",
      "  args = [\"mcp\", '--auto-project']",
      "# a comment with = and [brackets]",
      "startup_timeout_sec = 20  # trailing",
      "enabled = false",
      "",
      "   ",
      'weird = "unterminated',
    ]) {
      expect(rejoin(line)).toBe(line);
    }
  });

  it("colours a table header, a key, and a string", () => {
    expect(kinds("[servers.gha-search]")).toEqual(["table"]);
    expect(tokenizeTomlLine('type = "stdio"')).toEqual([
      { text: "type", kind: "key" },
      { text: " ", kind: "plain" },
      { text: "=", kind: "plain" },
      { text: " ", kind: "plain" },
      { text: '"stdio"', kind: "string" },
    ]);
  });

  it("treats a bare word after the equals as a value, not a key", () => {
    // Only the leading word on a line is a key; colouring both the same way is
    // what makes a TOML file read as undifferentiated text.
    expect(kinds("key = value")).toEqual(["key", "plain", "plain", "plain", "plain"]);
  });

  it("takes a comment to end of line, whatever it contains", () => {
    expect(kinds('# type = "stdio"')).toEqual(["comment"]);
  });

  it("does not mistake a quoted bracket for a table header", () => {
    const tokens = tokenizeTomlLine('args = ["[not-a-table]"]');
    expect(tokens.some((t) => t.kind === "table")).toBe(false);
  });
});

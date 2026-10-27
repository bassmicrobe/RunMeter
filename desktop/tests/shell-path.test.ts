import assert from "node:assert/strict";
import test from "node:test";
import { mergeMacPath } from "../shell-path.ts";

test("a Finder-launched Mac app finds Codex from the login shell PATH first", () => {
  const path = mergeMacPath({
    currentPath: "/usr/bin:/bin",
    shellOutput: "profile noise\n__RUNMETER_PATH__/Users/user/.nvm/bin:relative:/usr/bin__RUNMETER_PATH__",
    home: "/Users/user",
  }).split(":");
  assert.deepEqual(path.slice(0, 3), ["/Users/user/.nvm/bin", "/usr/bin", "/bin"]);
  assert.ok(path.includes("/opt/homebrew/bin"));
  assert.equal(path.at(-1), "/Applications/Codex.app/Contents/Resources");
  assert.equal(path.includes("relative"), false);
});

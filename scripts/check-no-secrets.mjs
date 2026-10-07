#!/usr/bin/env node
/**
 * Fail if fixtures (or dist sample payloads) contain secret-like values.
 * Used by CI / gate A.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const roots = ["tests/fixtures"];
const patterns = [
  /consail_[a-zA-Z0-9]{16,}/,
  /"password"\s*:\s*"[^"]+"/i,
  /"secret(?:_value)?"\s*:\s*"[^"]+"/i,
  /BEGIN (RSA |OPENSSH )?PRIVATE KEY/,
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@/i,
];

let failed = false;
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const file of readdirSync(root)) {
    const text = readFileSync(join(root, file), "utf8");
    for (const re of patterns) {
      if (re.test(text)) {
        console.error(`secret-like match in ${root}/${file}: ${re}`);
        failed = true;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log("check:secrets ok");

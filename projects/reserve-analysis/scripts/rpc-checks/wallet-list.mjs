// Loader for the reviewed wallet list used by the reserve-analysis checks.
//
// The list itself is per-account holder data and must never be committed to
// this public repo, so it lives in _wallet-list.json, which the leading-
// underscore convention in .gitignore keeps local-only. Copy
// wallet-list.example.json to _wallet-list.json and fill it in before running
// any script that imports this module.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST_PATH = join(HERE, "_wallet-list.json");

export function loadWalletList() {
  if (!existsSync(LIST_PATH)) {
    throw new Error(
      `Wallet list not found at ${LIST_PATH}.\n` +
        `Copy wallet-list.example.json to _wallet-list.json and populate it. ` +
        `The populated file is intentionally gitignored and must stay local.`
    );
  }
  const parsed = JSON.parse(readFileSync(LIST_PATH, "utf8"));
  for (const section of ["celo", "xdc", "watch"]) {
    if (!Array.isArray(parsed[section])) {
      throw new Error(`Wallet list is missing the "${section}" array.`);
    }
  }
  return parsed;
}

// Lowercased address Set for a section, for cross-reference lookups.
export function addressSet(section) {
  return new Set(loadWalletList()[section].map((w) => w.address.toLowerCase()));
}

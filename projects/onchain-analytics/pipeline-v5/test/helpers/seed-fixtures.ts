/**
 * Fixture builders for the two control seeds.
 *
 * Every fixture starts from a row that is VALID in all 23 (or 19) fields and mutates exactly one
 * thing. That is the point: a test that builds a row with three defects proves only that something
 * was wrong, and the whole purpose of the strict parser is to name which byte.
 */

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { topic0For } from "../../src/control-plane/eventSurface.js";

export const UBI = "0x22867567e2d80f2049200e25c6f31cb6ec2f0faf";
export const IMPL_A = "0x1111111111111111111111111111111111111111";
export const IMPL_B = "0x2222222222222222222222222222222222222222";
export const CODE_HASH = "0x" + "ab".repeat(32);
export const INT64_MAX = "9223372036854775807";

export const REGISTRY_COLUMNS = [
  "chain", "chain_id", "contract_name", "category", "provenance", "proxy_address",
  "implementation_address", "implementation_name", "era_index", "era_count", "valid_from_block",
  "valid_to_block", "is_live", "creation_block", "creation_method", "era_method", "era_evidence",
  "era_announcement_event", "abi_source", "runtime_code_hash", "semantics_note", "source", "notes",
] as const;

export const SURFACE_COLUMNS = [
  "chain", "chain_id", "contract_name", "proxy_address", "era_index", "implementation_address",
  "event_name", "event_signature", "topic0", "anonymous", "indexed_positions", "param_types",
  "param_names", "era_bound", "era_bound_from_block", "era_bound_to_block", "abi_source",
  "source", "notes",
] as const;

export type RegistryFields = Partial<Record<(typeof REGISTRY_COLUMNS)[number], string>>;
export type SurfaceFields = Partial<Record<(typeof SURFACE_COLUMNS)[number], string>>;

const REGISTRY_ERA_1: Required<RegistryFields> = {
  chain: "XDC", chain_id: "50", contract_name: "UBIScheme", category: "gooddollar_owned",
  provenance: "published", proxy_address: UBI, implementation_address: IMPL_A,
  implementation_name: "UBISchemeV1", era_index: "1", era_count: "2",
  valid_from_block: "105000000", valid_to_block: "106000000", is_live: "false",
  creation_block: "105000000", creation_method: "explorer_index_and_state_read_agree",
  era_method: "bisection_and_announcement_union", era_evidence: "contract_creation",
  era_announcement_event: "Upgraded(address)", abi_source: "etherscan_v2_verified_source",
  runtime_code_hash: CODE_HASH, semantics_note: "", source: "fixture", notes: "",
};

const REGISTRY_ERA_2: Required<RegistryFields> = {
  ...REGISTRY_ERA_1,
  implementation_address: IMPL_B, implementation_name: "UBISchemeV2", era_index: "2",
  valid_from_block: "106000000", valid_to_block: INT64_MAX, is_live: "true",
  era_evidence: "slot_bisection_and_announcement_log",
};

const SURFACE_BASE: Required<SurfaceFields> = {
  chain: "XDC", chain_id: "50", contract_name: "UBIScheme", proxy_address: UBI, era_index: "1",
  implementation_address: IMPL_A, event_name: "UBIClaimed",
  event_signature: "UBIClaimed(address,uint256)",
  topic0: topic0For("UBIClaimed(address,uint256)"), anonymous: "false", indexed_positions: "0",
  param_types: "address uint256", param_names: "claimer amount", era_bound: "false",
  era_bound_from_block: "", era_bound_to_block: "",
  abi_source: "etherscan_v2_verified_source", source: "fixture", notes: "",
};

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function line(columns: readonly string[], row: Record<string, string>): string {
  return columns.map((c) => quote(row[c])).join(",");
}

export function registryRow(overrides: RegistryFields = {}, base = REGISTRY_ERA_1): string {
  return line(REGISTRY_COLUMNS, { ...base, ...overrides });
}

/** The declared trailing block Phase 2 task 16 appends. Absent from the shipped seed today. */
export const REGISTRY_BOUNDARY_COLUMNS = [
  "boundary_completeness", "boundary_evidence_manifest_hash", "boundary_checked_through_block",
  "frozen_safe_head", "release_scope",
] as const;

export const REGISTRY_COLUMNS_WITH_BOUNDARY = [...REGISTRY_COLUMNS, ...REGISTRY_BOUNDARY_COLUMNS] as const;

const BOUNDARY_DEFAULT: Record<string, string> = {
  boundary_completeness: "raw_only_unproven",
  boundary_evidence_manifest_hash: "",
  boundary_checked_through_block: "",
  frozen_safe_head: "",
  release_scope: "in_release",
};

export function registryRowWithBoundary(
  overrides: RegistryFields & Partial<Record<(typeof REGISTRY_BOUNDARY_COLUMNS)[number], string>> = {},
  base = REGISTRY_ERA_1,
): string {
  return line(REGISTRY_COLUMNS_WITH_BOUNDARY, { ...base, ...BOUNDARY_DEFAULT, ...overrides });
}

export function writeRegistryWithBoundary(body: readonly string[]): string {
  return writeSeed("contract_deployments.csv", REGISTRY_COLUMNS_WITH_BOUNDARY, body).path;
}

export function registryEra2Row(overrides: RegistryFields = {}): string {
  return registryRow(overrides, REGISTRY_ERA_2);
}

export function surfaceRow(overrides: SurfaceFields = {}): string {
  const merged = { ...SURFACE_BASE, ...overrides };
  // Keep topic0 honest unless a test is deliberately corrupting it.
  if (overrides.event_signature && overrides.topic0 === undefined) {
    merged.topic0 = merged.anonymous === "true" ? "" : topic0For(merged.event_signature);
  }
  return line(SURFACE_COLUMNS, merged);
}

/** A two-era contract whose intervals touch exactly and whose final era is open ended. */
export function validRegistryBody(): string[] {
  return [registryRow(), registryEra2Row()];
}

export interface SeedFile {
  readonly dir: string;
  readonly path: string;
}

export function writeSeed(
  name: string,
  columns: readonly string[],
  body: readonly string[],
  opts: { terminator?: string; header?: string; trailingTerminator?: boolean } = {},
): SeedFile {
  const dir = mkdtempSync(join(tmpdir(), "control-plane-"));
  const path = join(dir, name);
  const terminator = opts.terminator ?? "\r\n";
  const header = opts.header ?? columns.join(",");
  const lines = [header, ...body].join(terminator);
  writeFileSync(path, opts.trailingTerminator === false ? lines : lines + terminator, "ascii");
  return { dir, path };
}

export function writeRegistry(body: readonly string[], opts?: Parameters<typeof writeSeed>[3]): string {
  return writeSeed("contract_deployments.csv", REGISTRY_COLUMNS, body, opts).path;
}

export function writeSurface(body: readonly string[], opts?: Parameters<typeof writeSeed>[3]): string {
  return writeSeed("event_surface.csv", SURFACE_COLUMNS, body, opts).path;
}

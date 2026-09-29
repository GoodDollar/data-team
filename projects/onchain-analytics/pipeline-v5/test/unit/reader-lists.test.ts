/**
 * reader-lists.test.ts -- the two questions an RPC endpoint can be asked about state, and why
 * they are now two lists.
 *
 * THE MEASUREMENT THAT PRODUCED THIS. Celo's endpoints were qualified against DEEP historical
 * state -- state old enough that a pruned node has discarded it -- and exactly one of three
 * passed. Read as "Celo has one state endpoint", that makes the two-endpoint agreement rule
 * unmeetable and turns a solved problem into a request to buy an archive endpoint.
 *
 * But nothing in this pipeline reads deep history. Every state read it performs is an `eth_call`
 * at a RECENT pin, which a node that prunes deep history still answers correctly. Re-measured
 * against the question actually being asked, across two separate OS processes on 2026-09-29,
 * four free endpoints qualify. The endpoint was never missing; the list was answering the wrong
 * question.
 *
 * The deep-archive list stays, stays at one endpoint for Celo, and stays recorded as a
 * limitation. It is simply not on any path in use.
 */

import { describe, it, expect } from "vitest";
import { NETWORKS } from "../../src/config.js";

describe("the state reader lists are two lists, because they answer two questions", () => {
  it("gives Celo four free recent-pin endpoints, which is what the two-endpoint rule needs", () => {
    const state = NETWORKS.CELO.readers.stateRpcUrls;
    expect(
      state.length,
      "the two-endpoint agreement rule needs at least two endpoints that answer eth_call"
    ).toBeGreaterThanOrEqual(2);
    expect(state).toContain("https://forno.celo.org");
    expect(state).toContain("https://celo.blockscout.com/api/eth-rpc");
    expect(state).toContain("https://rpc.ankr.com/celo");
    expect(state).toContain("https://1rpc.io/celo");
  });

  it("keeps celo.drpc.org out of the state list, because it answers neither question", () => {
    // Measured across two separate OS processes: eth_call 0 of 6, eth_blockNumber 2 of 6. It
    // contributes errors rather than answers, and an endpoint that only ever fails makes
    // agreement harder to reach rather than easier.
    expect(NETWORKS.CELO.readers.stateRpcUrls).not.toContain("https://celo.drpc.org");
    expect(NETWORKS.CELO.readers.archiveRpcUrls).not.toContain("https://celo.drpc.org");
  });

  it("keeps the deep-archive list narrow, and keeps its limitation recorded rather than hidden", () => {
    // ankr serves a recent pin and holds NO state below Celo's L1-to-L2 migration at block
    // 31,056,500, so it qualifies for one list and not the other. That is the whole reason the
    // lists are separate, and widening the archive list to make a number look better would be
    // the failure this split exists to prevent.
    expect(NETWORKS.CELO.readers.archiveRpcUrls).toEqual(["https://forno.celo.org"]);
    expect(NETWORKS.CELO.readers.notes).toMatch(/deep-archive list is\s+genuinely one endpoint/);
  });

  it("gives every chain a state list, so no chain silently falls back to the archive list", () => {
    for (const [name, network] of Object.entries(NETWORKS)) {
      expect(
        network.readers.stateRpcUrls.length,
        `${name} declares no state endpoints, so consensusRead would fall back to the ` +
        `deep-archive list and re-inherit the defect this split removed.`
      ).toBeGreaterThan(0);
    }
  });
});

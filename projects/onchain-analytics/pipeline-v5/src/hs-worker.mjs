/**
 * hs-worker.mjs
 *
 * Performs ONE HyperSync collection and exits. It exists so that the parent can impose a REAL
 * timeout: the HyperSync client retries internally without bound, so a job that hits a 429 storm
 * never returns, never throws, and cannot be cancelled in-process. Killing a child process can.
 * Node's fetch has no default timeout either, which is how a backfill in this project hung
 * indefinitely on one socket while looking exactly like slow work.
 *
 * Protocol: request JSON on argv[2], result JSON on stdout between the markers below.
 *
 * This file is deliberately plain .mjs rather than TypeScript, so the parent can spawn it with
 * the bare node binary and no loader. It has no dependency on the rest of the pipeline.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HypersyncClient } = require("@envio-dev/hypersync-client");

const START = "<<<HS_RESULT_START>>>";
const END = "<<<HS_RESULT_END>>>";

// The client returns BigInt for uint fields, which JSON.stringify refuses outright. Rendering
// them as strings keeps full precision across the process boundary; a Number would silently
// round anything above 2^53, and tx_value is a uint256.
const bigIntSafe = (_key, value) => (typeof value === "bigint" ? value.toString() : value);

function emit(obj) {
  process.stdout.write(START + JSON.stringify(obj, bigIntSafe) + END);
}

async function main() {
  const req = JSON.parse(process.argv[2]);

  if (!req.token) throw new Error("ENVIO_API_TOKEN missing in worker request");
  const client = HypersyncClient.new({ url: req.url, bearerToken: req.token });

  if (req.op === "height") {
    const height = await client.getHeight();
    return emit({ ok: true, op: "height", height: Number(height) });
  }

  const query = {
    fromBlock: req.fromBlock,
    toBlock: req.toBlock,
    logs: [{ address: req.addresses }],
    // EVERY FIELD HERE IS TAKEN FROM THE INSTALLED CLIENT'S OWN ENUMS, NOT FROM RECOLLECTION.
    // LogField offers twelve and the previous selection requested eleven. The one it left out was
    // Removed, which is why the v4 `removed` column was described as unpopulatable: the reader
    // offers it and nobody asked. A log the source reports as removed by a reorganisation is the
    // single most important thing this pipeline can be told, and it was being discarded at the
    // request.
    //
    // The transaction list gained Gas, Kind, Input, ContractAddress, BlockNumber and BlockHash.
    // Those are not extras: the v4 Transactions table declares gas_limit, tx_type,
    // input_selector, contract_created, block_number and block_hash, and all six were offered by
    // the client and unrequested. Note that the gas LIMIT is `Gas` while `GasUsed` is the receipt
    // figure; taking the wrong one of a similarly named pair is a defect this project has
    // shipped before.
    fieldSelection: {
      log: [
        "BlockNumber", "BlockHash", "TransactionHash", "TransactionIndex",
        "LogIndex", "Address", "Data", "Topic0", "Topic1", "Topic2", "Topic3", "Removed",
      ],
      transaction: [
        "Hash", "BlockNumber", "BlockHash", "TransactionIndex", "From", "To", "Value",
        "Status", "Nonce", "Gas", "GasUsed", "EffectiveGasPrice", "Input", "ContractAddress", "Kind",
      ],
      block: ["Number", "Hash", "Timestamp"],
    },
  };

  const res = await client.collect(query, {});

  // nextBlock is how a short collection announces itself. The client can return fewer blocks
  // than asked for without raising anything, and a caller that ignores nextBlock reads a
  // truncated range as a complete one. The parent refuses any chunk where this is short.
  //
  // rollbackGuard is how the client announces that blocks it previously served may be rolled
  // back, and the previous version of this file DROPPED IT. An exhaustive search of the pipeline
  // for rollback, orphan or reorg-removal handling returned nothing at all, so the disappearing
  // log shape was undetectable: the detector was offered by the client and never read. It is
  // passed through here and recorded by the caller.
  emit({
    ok: true,
    op: "collect",
    fromBlock: req.fromBlock,
    toBlock: req.toBlock,
    nextBlock: res.nextBlock === undefined || res.nextBlock === null ? null : Number(res.nextBlock),
    archiveHeight: res.archiveHeight === undefined || res.archiveHeight === null ? null : Number(res.archiveHeight),
    rollbackGuard: res.rollbackGuard ?? null,
    logs: res.data.logs ?? [],
    transactions: res.data.transactions ?? [],
    blocks: res.data.blocks ?? [],
  });
}

main().catch((e) => {
  emit({ ok: false, error: String((e && e.message) || e) });
  process.exitCode = 1;
});

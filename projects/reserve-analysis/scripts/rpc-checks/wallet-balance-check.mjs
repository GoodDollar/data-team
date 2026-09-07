// Live balance snapshot for a configured wallet list across all chains where
// GD exists. No historical scan here, just current balanceOf + native
// balance, each with the block number so the snapshot is reproducible at a
// point in time. Edit WALLETS below for whatever addresses you need to check.

const CHAINS = {
  celo: {
    rpcEndpoints: ["https://forno.celo.org", "https://rpc.ankr.com/celo", "https://1rpc.io/celo"],
    gdToken: "0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a",
    nativeSymbol: "CELO"
  },
  xdc: {
    rpcEndpoints: ["https://rpc.xinfin.network", "https://erpc.xinfin.network", "https://rpc.ankr.com/xdc", "https://xdc.public-rpc.com"],
    gdToken: "0xec2136843a983885aebf2feb3931f73a8ebee50c",
    nativeSymbol: "XDC"
  },
  fuse: {
    rpcEndpoints: ["https://rpc.fuse.io", "https://fuse-pokt.nodies.app", "https://rpc.ankr.com/fuse"],
    gdToken: "0x495d133b938596c9984d462f007b676bdc57ecec",
    nativeSymbol: "FUSE"
  },
  ethereum: {
    rpcEndpoints: ["https://eth.llamarpc.com", "https://rpc.ankr.com/eth", "https://ethereum.publicnode.com", "https://cloudflare-eth.com"],
    gdToken: "0x67c5870b4a41d4ebef24d2456547a03f1f3e094b",
    nativeSymbol: "ETH"
  }
};

const WALLETS = [
  { label: "wallet 1", address: "0x0000000000000000000000000000000000000000" },
  { label: "wallet 2", address: "0x0000000000000000000000000000000000000000" }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(endpoints, method, params, epIndex = 0, attempt = 1) {
  const url = endpoints[epIndex % endpoints.length];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
  });

  if (res.status === 403 || res.status === 429) {
    if (attempt >= endpoints.length * 2) throw new Error(`HTTP ${res.status} calling ${method} on ${url}`);
    await sleep(400);
    return rpc(endpoints, method, params, epIndex + 1, attempt + 1);
  }
  if (!res.ok) {
    if (attempt >= endpoints.length * 2) throw new Error(`HTTP ${res.status} calling ${method} on ${url}`);
    return rpc(endpoints, method, params, epIndex + 1, attempt + 1);
  }

  const json = await res.json();
  if (json.error) {
    if (attempt >= endpoints.length * 2) throw new Error(`RPC error calling ${method} on ${url}: ${json.error.message}`);
    return rpc(endpoints, method, params, epIndex + 1, attempt + 1);
  }
  await sleep(200);
  return json.result;
}

function toDecimal(hexOrBigInt, decimals = 18) {
  const big = typeof hexOrBigInt === "bigint" ? hexOrBigInt : BigInt(hexOrBigInt);
  return Number(big) / Math.pow(10, decimals);
}

async function balanceOf(endpoints, token, holder) {
  const selector = "0x70a08231";
  const padded = holder.replace("0x", "").padStart(64, "0");
  const result = await rpc(endpoints, "eth_call", [{ to: token, data: selector + padded }, "latest"]);
  return toDecimal(result);
}

async function nativeBalance(endpoints, holder) {
  const result = await rpc(endpoints, "eth_getBalance", [holder, "latest"]);
  return toDecimal(result);
}

async function blockNumber(endpoints) {
  return Number(BigInt(await rpc(endpoints, "eth_blockNumber", [])));
}

async function main() {
  const output = { generatedAt: new Date().toISOString(), chains: {} };

  for (const [chainName, cfg] of Object.entries(CHAINS)) {
    const chainResult = { blockNumber: null, wallets: [] };
    try {
      chainResult.blockNumber = await blockNumber(cfg.rpcEndpoints);
    } catch (err) {
      chainResult.error = `Could not reach any RPC endpoint: ${err.message}`;
      output.chains[chainName] = chainResult;
      continue;
    }

    for (const wallet of WALLETS) {
      try {
        const gd = await balanceOf(cfg.rpcEndpoints, cfg.gdToken, wallet.address);
        const native = await nativeBalance(cfg.rpcEndpoints, wallet.address);
        chainResult.wallets.push({
          label: wallet.label,
          address: wallet.address,
          gdBalance: gd,
          [`${cfg.nativeSymbol.toLowerCase()}Balance`]: native
        });
      } catch (err) {
        chainResult.wallets.push({ label: wallet.label, address: wallet.address, error: err.message });
      }
    }

    output.chains[chainName] = chainResult;
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});

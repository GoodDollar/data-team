const XDC_RPC_URL = "https://rpc.xinfin.network";
const XDC_RESERVE_SUBGRAPH_URL = "https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/reserve_xdc/v1.0.0/gn";
const FUSE_EXPLORER_API = "https://explorer.fuse.io/api/v2";

const CONFIG = {
  xdcWindow: {
    startIso: "2026-09-04T04:06:58Z",
    endIso: "2026-09-04T13:43:31Z"
  },
  fuseWindow: {
    startIso: "2026-09-03T00:00:00Z",
    endIso: "2026-09-04T12:00:00Z"
  },
  fuse: {
    gdToken: "0x495d133b938596c9984d462f007b676bdc57ecec",
    routers: [
      "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
      "0xa3247276dbcc76dd7705273f766eb3e8a5ecf4a5",
      "0xfb152fc469a3e9154f8aa60bbd6700ecbc357a54"
    ]
  }
};

function toUnix(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function toLower(value) {
  return String(value || "").toLowerCase();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchXdcReserveEvents() {
  const startTs = toUnix(CONFIG.xdcWindow.startIso);
  const endTs = toUnix(CONFIG.xdcWindow.endIso);

  const query = `query {
    reservePrices(
      first: 200,
      orderBy: timestamp,
      orderDirection: asc,
      where: { timestamp_gte: "${startTs}", timestamp_lte: "${endTs}" }
    ) {
      id
      amountOut
      timestamp
      price
    }
  }`;

  const payload = await postJson(XDC_RESERVE_SUBGRAPH_URL, { query });
  const rows = (payload?.data?.reservePrices || []).map((r) => ({
    id: r.id,
    txHash: String(r.id).split("-")[0],
    amountOut: Number(r.amountOut) / 1e6,
    timestamp: Number(r.timestamp),
    priceRaw: Number(r.price)
  }));

  return {
    startIso: CONFIG.xdcWindow.startIso,
    endIso: CONFIG.xdcWindow.endIso,
    eventCount: rows.length,
    totalOut: rows.reduce((a, b) => a + b.amountOut, 0),
    rows
  };
}

async function getXdcTxSender(txHash) {
  const payload = {
    jsonrpc: "2.0",
    method: "eth_getTransactionByHash",
    params: [txHash],
    id: 1
  };
  const res = await postJson(XDC_RPC_URL, payload);
  return toLower(res?.result?.from || "");
}

async function buildXdcSellerAttribution(events) {
  const bySeller = new Map();

  for (const ev of events.rows) {
    const seller = await getXdcTxSender(ev.txHash);
    if (!seller) continue;

    if (!bySeller.has(seller)) {
      bySeller.set(seller, {
        seller,
        outflow: 0,
        txHashes: []
      });
    }

    const row = bySeller.get(seller);
    row.outflow += ev.amountOut;
    row.txHashes.push(ev.txHash);
  }

  return [...bySeller.values()]
    .map((r) => ({
      seller: r.seller,
      outflow: Number(r.outflow.toFixed(6)),
      txCount: r.txHashes.length,
      txHashes: r.txHashes
    }))
    .sort((a, b) => b.outflow - a.outflow);
}

function transferAmount(value, decimals) {
  return Number(value) / Math.pow(10, Number(decimals));
}

async function fetchFuseRouterTransfers(router) {
  const out = [];
  let cursor = null;
  let guard = 0;
  const start = new Date(CONFIG.fuseWindow.startIso).getTime();
  const end = new Date(CONFIG.fuseWindow.endIso).getTime();

  while (guard < 120) {
    guard += 1;
    let url = `${FUSE_EXPLORER_API}/addresses/${router}/token-transfers?type=ERC-20`;
    if (cursor?.block_number != null && cursor?.index != null) {
      url += `&block_number=${cursor.block_number}&index=${cursor.index}`;
    }

    const page = await getJson(url);
    const items = page?.items || [];
    if (!items.length) break;

    let reachedOlderRows = false;
    for (const item of items) {
      const ts = new Date(item.timestamp).getTime();
      if (ts < start) {
        reachedOlderRows = true;
        break;
      }
      if (ts > end) continue;

      out.push(item);
    }

    if (reachedOlderRows) break;
    cursor = page?.next_page_params;
    if (!cursor) break;
  }

  return out;
}

async function buildFuseTop2() {
  const gd = toLower(CONFIG.fuse.gdToken);
  const transferRows = [];

  for (const router of CONFIG.fuse.routers) {
    const items = await fetchFuseRouterTransfers(router);
    for (const item of items) {
      const from = toLower(item?.from?.hash);
      const to = toLower(item?.to?.hash);
      const token = toLower(item?.token?.address_hash);

      if (from !== toLower(router)) continue;
      if (token === gd) continue;

      transferRows.push({
        router: toLower(router),
        timestamp: item.timestamp,
        txHash: item.transaction_hash,
        recipient: to,
        token,
        symbol: item?.token?.symbol || "UNKNOWN",
        amount: transferAmount(item?.total?.value || "0", item?.total?.decimals || "18")
      });
    }
  }

  const byRecipient = new Map();
  for (const row of transferRows) {
    if (!byRecipient.has(row.recipient)) {
      byRecipient.set(row.recipient, {
        recipient: row.recipient,
        total: 0,
        txSet: new Set(),
        tokens: new Map()
      });
    }

    const agg = byRecipient.get(row.recipient);
    agg.total += row.amount;
    agg.txSet.add(row.txHash);
    const tokenKey = `${row.symbol}:${row.token}`;
    agg.tokens.set(tokenKey, (agg.tokens.get(tokenKey) || 0) + row.amount);
  }

  const ranked = [...byRecipient.values()]
    .map((row) => ({
      recipient: row.recipient,
      total: Number(row.total.toFixed(6)),
      txCount: row.txSet.size,
      txHashes: [...row.txSet],
      tokenBreakdown: [...row.tokens.entries()]
        .map(([tokenKey, amount]) => {
          const [symbol, token] = tokenKey.split(":");
          return { symbol, token, amount: Number(amount.toFixed(6)) };
        })
        .sort((a, b) => b.amount - a.amount)
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 2);

  return {
    startIso: CONFIG.fuseWindow.startIso,
    endIso: CONFIG.fuseWindow.endIso,
    routeOutflowRows: transferRows.length,
    top2: ranked
  };
}

async function main() {
  const xdcEvents = await fetchXdcReserveEvents();
  const xdcSellers = await buildXdcSellerAttribution(xdcEvents);
  const fuse = await buildFuseTop2();

  const output = {
    generatedAt: new Date().toISOString(),
    sources: {
      xdcReserveSubgraph: XDC_RESERVE_SUBGRAPH_URL,
      xdcRpc: XDC_RPC_URL,
      fuseExplorer: FUSE_EXPLORER_API
    },
    xdc: {
      windowStart: xdcEvents.startIso,
      windowEnd: xdcEvents.endIso,
      reserveSwapEvents: xdcEvents.eventCount,
      totalReserveOutflow: Number(xdcEvents.totalOut.toFixed(6)),
      sellers: xdcSellers
    },
    fuse
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

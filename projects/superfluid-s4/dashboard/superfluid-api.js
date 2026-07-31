/**
 * Superfluid Points API Client -- GoodDollar SUP Rewards Campaign
 *
 * Data-fetching and transformation logic for the Superfluid Points API.
 * Used by the campaign dashboard HTML page (presentation layer).
 *
 * API docs: https://cms.superfluid.pro/points/openapi.json
 * All query endpoints are PUBLIC (no API key required).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const CONFIG = {
  API_BASE: 'https://cms.superfluid.pro',
  CAMPAIGN_1_ID: 606,       // S6 GoodDollar (Pool 1: GD Actions)
  CAMPAIGN_2_ID: 614,       // S6 GoodDollar 2 (Pool 2: Ecosystem Funding)
  POOL_1_ALLOCATION: 217700, // SUP tokens
  POOL_2_ALLOCATION: 404300, // SUP tokens
  TOTAL_ALLOCATION: 622000,  // SUP tokens
  PAGE_SIZE: 10,
};

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  return res.json();
}

/**
 * Fetch campaign metadata (name, totalPoints, memberCount, totalEvents).
 * @param {number} campaignId
 * @returns {Promise<CampaignMeta>}
 */
export async function fetchCampaign(campaignId) {
  return fetchJSON(
    `${CONFIG.API_BASE}/points/campaign?campaignId=${campaignId}`
  );
}

/**
 * Fetch a page of the leaderboard, ordered by totalPoints descending.
 * @param {number} campaignId
 * @param {number} page - 1-indexed
 * @param {number} limit - max 100
 * @returns {Promise<{accounts: AccountEntry[], pagination: Pagination}>}
 */
export async function fetchLeaderboard(campaignId, page = 1, limit = CONFIG.PAGE_SIZE) {
  return fetchJSON(
    `${CONFIG.API_BASE}/points/accounts?campaignId=${campaignId}` +
    `&orderBy=totalPoints&order=desc&page=${page}&limit=${limit}`
  );
}

/**
 * Fetch a single user's balance across multiple campaigns in one call.
 * @param {string} account - Ethereum address (0x...)
 * @param {number[]} campaignIds - defaults to both configured campaigns
 * @returns {Promise<Object>}
 */
export async function fetchBalanceBatch(account, campaignIds) {
  const ids = campaignIds || [CONFIG.CAMPAIGN_1_ID, CONFIG.CAMPAIGN_2_ID];
  const res = await fetch(`${CONFIG.API_BASE}/points/balance-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignIds: ids, account }),
  });
  if (!res.ok) throw new Error(`Balance API error: ${res.status}`);
  return res.json();
}

/**
 * Fetch a page of events for a campaign.
 * @param {number} campaignId
 * @param {number} page
 * @param {number} limit
 * @returns {Promise<{events: EventEntry[], pagination: Pagination}>}
 */
export async function fetchEvents(campaignId, page = 1, limit = 100) {
  return fetchJSON(
    `${CONFIG.API_BASE}/points/events?campaignId=${campaignId}` +
    `&limit=${limit}&page=${page}`
  );
}

/**
 * Fetch ALL events for a campaign by paginating through every page.
 * Capped at 200 pages (20,000 events) as a safety limit.
 * @param {number} campaignId
 * @returns {Promise<EventEntry[]>}
 */
export async function fetchAllEvents(campaignId) {
  const all = [];
  let page = 1;
  let hasNext = true;
  while (hasNext && page <= 200) {
    const data = await fetchEvents(campaignId, page, 100);
    all.push(...(data.events || []));
    hasNext = data.pagination?.hasNextPage || false;
    page++;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Data Transformations
// ---------------------------------------------------------------------------

/**
 * Calculate estimated SUP reward for a user in a single pool.
 * @param {number} userPoints - user's points in this pool
 * @param {number} totalPoolPoints - total points across all users in this pool
 * @param {number} poolAllocation - total SUP allocated to this pool
 * @returns {number} estimated SUP reward
 */
export function calculateReward(userPoints, totalPoolPoints, poolAllocation) {
  if (totalPoolPoints <= 0 || userPoints <= 0) return 0;
  return (userPoints / totalPoolPoints) * poolAllocation;
}

/**
 * Calculate combined reward across both pools.
 * @param {number} pool1Points - user's Pool 1 points
 * @param {number} pool2Points - user's Pool 2 points
 * @param {number} totalPool1Points - total Pool 1 points
 * @param {number} totalPool2Points - total Pool 2 points
 * @returns {{pool1Reward: number, pool2Reward: number, totalReward: number}}
 */
export function calculateCombinedReward(pool1Points, pool2Points, totalPool1Points, totalPool2Points) {
  const pool1Reward = calculateReward(pool1Points, totalPool1Points, CONFIG.POOL_1_ALLOCATION);
  const pool2Reward = calculateReward(pool2Points, totalPool2Points, CONFIG.POOL_2_ALLOCATION);
  return {
    pool1Reward,
    pool2Reward,
    totalReward: pool1Reward + pool2Reward,
  };
}

/**
 * Parse balance-batch response into per-campaign points.
 * Handles both array and object response shapes.
 * @param {Object} balances - raw API response
 * @returns {{pool1Points: number, pool2Points: number}}
 */
export function parseBalanceBatch(balances) {
  let pool1Points = 0;
  let pool2Points = 0;

  if (Array.isArray(balances)) {
    balances.forEach(b => {
      if (b.campaignId === CONFIG.CAMPAIGN_1_ID) pool1Points = b.points || b.totalPoints || 0;
      if (b.campaignId === CONFIG.CAMPAIGN_2_ID) pool2Points = b.points || b.totalPoints || 0;
    });
  } else if (balances && typeof balances === 'object') {
    const c1 = balances[CONFIG.CAMPAIGN_1_ID];
    const c2 = balances[CONFIG.CAMPAIGN_2_ID];
    pool1Points = c1?.points || c1?.totalPoints || 0;
    pool2Points = c2?.points || c2?.totalPoints || 0;
  }

  return { pool1Points, pool2Points };
}

/**
 * Aggregate events into daily counts.
 * @param {EventEntry[]} events
 * @returns {{dates: string[], counts: number[]}} sorted chronologically
 */
export function aggregateDailyCounts(events) {
  const daily = {};
  events.forEach(e => {
    const date = (e.createdAt || '').slice(0, 10);
    if (date) daily[date] = (daily[date] || 0) + 1;
  });
  const dates = Object.keys(daily).sort();
  return { dates, counts: dates.map(d => daily[d]) };
}

/**
 * Compute cumulative new participants over time from events.
 * @param {EventEntry[]} events
 * @returns {{dates: string[], cumulative: number[]}}
 */
export function computeCumulativeParticipants(events) {
  const firstSeen = {};
  events.forEach(e => {
    const date = (e.createdAt || '').slice(0, 10);
    const acct = e.account;
    if (date && acct && (!firstSeen[acct] || date < firstSeen[acct])) {
      firstSeen[acct] = date;
    }
  });

  const newPerDay = {};
  Object.values(firstSeen).forEach(d => { newPerDay[d] = (newPerDay[d] || 0) + 1; });

  const dates = Object.keys(newPerDay).sort();
  let cumul = 0;
  const cumulative = dates.map(d => { cumul += newPerDay[d]; return cumul; });

  return { dates, cumulative };
}

/**
 * Compute point distribution buckets for a histogram.
 * Uses logarithmic buckets for wide ranges, linear for narrow.
 * @param {number[]} pointValues - array of point totals per user
 * @param {number} maxBuckets - target number of buckets
 * @returns {{labels: string[], counts: number[]}}
 */
export function computePointDistribution(pointValues, maxBuckets = 12) {
  const filtered = pointValues.filter(p => p > 0);
  if (filtered.length === 0) return { labels: [], counts: [] };

  const max = Math.max(...filtered);
  const min = Math.min(...filtered);

  let bounds;
  if (max > 100) {
    const logMax = Math.log10(max);
    const logMin = Math.log10(Math.max(min, 1));
    const steps = Math.min(maxBuckets, Math.ceil(logMax - logMin + 1) * 2);
    bounds = [];
    for (let i = 0; i <= steps; i++) {
      bounds.push(Math.round(Math.pow(10, logMin + (logMax - logMin) * i / steps)));
    }
    bounds = [...new Set(bounds)].sort((a, b) => a - b);
  } else {
    const bucketSize = Math.ceil(max / 10) || 1;
    bounds = [];
    for (let i = 0; i <= max; i += bucketSize) bounds.push(i);
    if (bounds[bounds.length - 1] < max) bounds.push(max);
  }

  const counts = Array(bounds.length - 1).fill(0);
  const labels = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    labels.push(`${bounds[i]}-${bounds[i + 1]}`);
  }

  filtered.forEach(p => {
    for (let i = bounds.length - 2; i >= 0; i--) {
      if (p >= bounds[i]) { counts[i]++; break; }
    }
  });

  return { labels, counts };
}

// ---------------------------------------------------------------------------
// Formatting Utilities
// ---------------------------------------------------------------------------

/**
 * Format a number with locale-specific thousands separators.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n === null || n === undefined) return '--';
  return Number(n).toLocaleString();
}

/**
 * Truncate an Ethereum address for display: 0x1234...abcd
 * @param {string} addr
 * @returns {string}
 */
export function truncateAddress(addr) {
  if (!addr || addr.length < 10) return addr || '--';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/**
 * Validate an Ethereum address format.
 * @param {string} addr
 * @returns {boolean}
 */
export function isValidAddress(addr) {
  return /^0x[0-9a-f]{40}$/i.test(addr);
}

// ---------------------------------------------------------------------------
// High-Level Data Loaders
// ---------------------------------------------------------------------------

/**
 * Load both campaign metadata in parallel.
 * @returns {Promise<{campaign1: CampaignMeta, campaign2: CampaignMeta}>}
 */
export async function loadCampaigns() {
  const [campaign1, campaign2] = await Promise.all([
    fetchCampaign(CONFIG.CAMPAIGN_1_ID),
    fetchCampaign(CONFIG.CAMPAIGN_2_ID),
  ]);
  return { campaign1, campaign2 };
}

/**
 * Look up a wallet's position across both pools.
 * @param {string} walletAddress
 * @param {CampaignMeta} campaign1
 * @param {CampaignMeta} campaign2
 * @returns {Promise<WalletResult>}
 */
export async function lookupWallet(walletAddress, campaign1, campaign2) {
  const balances = await fetchBalanceBatch(walletAddress.toLowerCase());
  const { pool1Points, pool2Points } = parseBalanceBatch(balances);
  const rewards = calculateCombinedReward(
    pool1Points, pool2Points,
    campaign1?.totalPoints || 0,
    campaign2?.totalPoints || 0
  );
  return { pool1Points, pool2Points, ...rewards };
}

/**
 * Load analytics data (all events from both campaigns).
 * @returns {Promise<{events1: EventEntry[], events2: EventEntry[]}>}
 */
export async function loadAllEvents() {
  const [events1, events2] = await Promise.all([
    fetchAllEvents(CONFIG.CAMPAIGN_1_ID),
    fetchAllEvents(CONFIG.CAMPAIGN_2_ID),
  ]);
  return { events1, events2 };
}

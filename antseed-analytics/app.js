// Antseed AI Credits Dashboard -- Application Logic
// Fetches daily analytics from the GoodDollar Antseed Worker and renders
// scorecards, charts (Chart.js), and a paginated summary table.
// Falls back to generated demo data when the endpoint is not yet deployed.

// === Configuration ===
const WORKER_URL = 'https://gooddollar-antseed-integration.goodworker.workers.dev';
const ANALYTICS_ENDPOINT = WORKER_URL + '/v1/analytics';
const REFRESH_ENDPOINT = WORKER_URL + '/v1/analytics/refresh';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TABLE_PAGE_SIZE = 10;

// === State ===
let analyticsData = null;
let liveData = null;       // cached live data (null if endpoint unreachable)
let demoData = null;       // cached demo data (generated once)
let currentPage = 1;
let totalPages = 1;
let refreshTimer = null;
let isDemo = false;
let liveAvailable = false; // whether the live endpoint responded successfully

// === Mock Data (shown when endpoint is not yet live) ===
function generateMockData() {
    const daily = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        // Ramp up activity over time
        const ramp = (30 - i) / 30;
        const deposits = Math.floor((800 + Math.random() * 1200) * ramp);
        const streamed = Math.floor((200 + Math.random() * 600) * ramp);
        const credits = Math.floor((50 + Math.random() * 150) * ramp);
        const buyers = Math.floor((2 + Math.random() * 8) * ramp) || 1;
        const creditU = Math.floor((1 + Math.random() * 5) * ramp) || 1;
        daily.push({
            date: dateStr,
            gdOneTimeDepositsWei: String(BigInt(deposits) * BigInt(10 ** 18)),
            gdStreamedWei: String(BigInt(streamed) * BigInt(10 ** 18)),
            gdTotalFlowRateWeiPerSecond: String(BigInt(Math.floor(streamed / 86400)) * BigInt(10 ** 18)),
            aiCreditsUsedWei: String(BigInt(credits) * BigInt(10 ** 6)),
            uniqueGdBuyers: buyers,
            uniqueCreditUsers: creditU,
            updatedAt: new Date().toISOString(),
            missing: false
        });
    }
    // Compute globals from daily totals
    let totalDeposits = BigInt(0), totalStreamed = BigInt(0), totalCredits = BigInt(0);
    daily.forEach(d => {
        totalDeposits += BigInt(d.gdOneTimeDepositsWei);
        totalStreamed += BigInt(d.gdStreamedWei);
        totalCredits += BigInt(d.aiCreditsUsedWei);
    });
    const lastDay = daily[daily.length - 1];
    return {
        days: 30,
        daily: daily,
        global: {
            gdOneTimeDepositsWei: String(totalDeposits),
            gdStreamedWei: String(totalStreamed),
            aiCreditsUsedWei: String(totalCredits),
            gdTotalFlowRateWeiPerSecond: lastDay.gdTotalFlowRateWeiPerSecond,
            updatedAt: new Date().toISOString()
        },
        lastRun: {
            currentDate: new Date().toISOString().slice(0, 10),
            updatedAt: new Date().toISOString()
        }
    };
}

// === BigInt Helpers ===
function weiToGd(weiStr) {
    // Convert 18-decimal wei string to G$ number
    if (!weiStr || weiStr === '0') return 0;
    const big = BigInt(weiStr);
    // Divide by 10^14 first to keep precision, then convert to Number and divide by 10^4
    const reduced = big / BigInt(10 ** 14);
    return Number(reduced) / 10000;
}

function weiToUsd(weiStr) {
    // Convert 6-decimal wei string to USD number
    if (!weiStr || weiStr === '0') return 0;
    const big = BigInt(weiStr);
    return Number(big) / 1e6;
}

function flowRateToDaily(weiPerSecStr) {
    // Convert wei/sec (18 decimals) to G$/day
    if (!weiPerSecStr || weiPerSecStr === '0') return 0;
    const big = BigInt(weiPerSecStr);
    const dailyWei = big * BigInt(86400);
    const reduced = dailyWei / BigInt(10 ** 14);
    return Number(reduced) / 10000;
}

// === Formatting ===
function fmtNum(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
    return n.toFixed(decimals);
}

function fmtGd(n) { return fmtNum(n, 2) + ' G$'; }
function fmtUsd(n) { return '$' + fmtNum(n, 2); }

// === API ===
async function fetchAnalytics() {
    const res = await fetch(ANALYTICS_ENDPOINT + '?days=365');
    if (!res.ok) throw new Error('API ' + res.status);
    return res.json();
}

async function postRefresh() {
    const res = await fetch(REFRESH_ENDPOINT, { method: 'POST' });
    if (!res.ok) throw new Error('Refresh API ' + res.status);
    return res.json();
}

// === Data Loading ===
async function loadData() {
    // Try live endpoint
    try {
        liveData = await fetchAnalytics();
        liveAvailable = true;
    } catch (err) {
        console.warn('Endpoint not reachable:', err.message);
        liveData = null;
        liveAvailable = false;
    }

    // Generate demo data once
    if (!demoData) demoData = generateMockData();

    // Default to live if available, otherwise demo
    if (liveAvailable) {
        analyticsData = liveData;
        isDemo = false;
    } else {
        analyticsData = demoData;
        isDemo = true;
    }

    updateUI();
    updateToggleState();
}

function switchSource(source) {
    if (source === 'live') {
        if (liveAvailable) {
            analyticsData = liveData;
            isDemo = false;
        } else {
            // Keep the UI visible with toggle, show "not deployed" in content areas
            isDemo = false;
            analyticsData = null;
            currentPage = 1;
            updateToggleState();
            document.getElementById('demo-banner').style.display = 'none';
            document.getElementById('demo-badge').style.display = 'none';
            // Show inline error in charts and table sections
            document.getElementById('charts-loading').style.display = 'none';
            document.getElementById('charts-content').style.display = 'none';
            document.getElementById('charts-section').querySelector('h2').insertAdjacentHTML('afterend',
                '<div id="charts-unavailable" class="empty-state">' +
                '<div class="emoji">&#128679;</div>' +
                '<p>Worker endpoint not reachable. The dashboard will auto-retry every 5 minutes.</p>' +
                '</div>');
            document.getElementById('table-content').innerHTML =
                '<div class="empty-state">' +
                '<div class="emoji">&#128679;</div>' +
                '<p>Live data will appear here once the Worker endpoint is reachable.</p>' +
                '</div>';
            document.getElementById('pagination').style.display = 'none';
            document.getElementById('stat-total-gd').textContent = '--';
            document.getElementById('stat-ai-credits').textContent = '--';
            document.getElementById('stat-flow-rate').textContent = '--';
            document.getElementById('last-updated-text').textContent = 'Endpoint not reachable - auto-retries every 5 min';
            return;
        }
    } else {
        analyticsData = demoData;
        isDemo = true;
    }
    currentPage = 1;
    // Remove inline error if it was shown
    var unavail = document.getElementById('charts-unavailable');
    if (unavail) unavail.remove();
    updateUI();
    updateToggleState();
}

function updateToggleState() {
    var liveBtn = document.getElementById('toggle-live');
    var demoBtn = document.getElementById('toggle-demo');
    liveBtn.classList.toggle('active', !isDemo);
    demoBtn.classList.toggle('active', isDemo);
    // Don't disable the live button -- clicking it shows the error state explaining why
}

function updateUI() {
    document.getElementById('main-content').style.display = 'block';
    document.getElementById('error-content').style.display = 'none';
    document.getElementById('demo-banner').style.display = isDemo ? 'block' : 'none';
    document.getElementById('demo-badge').style.display = isDemo ? 'inline-block' : 'none';
    // Clean up any inline error from live-unavailable state
    var unavail = document.getElementById('charts-unavailable');
    if (unavail) unavail.remove();
    // Reset charts loading state for re-render
    document.getElementById('charts-loading').style.display = 'flex';
    document.getElementById('charts-loading').innerHTML = '<div class="loading-spinner"></div><span style="color: var(--text-secondary); font-size: 0.85rem;">Loading analytics...</span>';
    document.getElementById('charts-content').style.display = 'none';
    renderHero();
    renderCharts();
    renderTable();
}

async function triggerRefresh() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('loading');
    btn.textContent = 'Refreshing...';
    try {
        await postRefresh();
        // Wait a moment for aggregation, then re-fetch
        setTimeout(async () => {
            await loadData();
            btn.classList.remove('loading');
            btn.textContent = 'Refresh';
        }, 2000);
    } catch (err) {
        console.error('Refresh failed:', err);
        btn.classList.remove('loading');
        btn.textContent = 'Refresh';
        // Still try to reload data
        await loadData();
    }
}

// === Rendering: Hero ===
function renderHero() {
    const g = analyticsData.global;
    const totalGd = weiToGd(g.gdOneTimeDepositsWei) + weiToGd(g.gdStreamedWei);
    const aiCredits = weiToUsd(g.aiCreditsUsedWei);
    const dailyFlow = flowRateToDaily(g.gdTotalFlowRateWeiPerSecond);

    document.getElementById('stat-total-gd').textContent = fmtGd(totalGd);
    document.getElementById('stat-ai-credits').textContent = fmtUsd(aiCredits);
    document.getElementById('stat-flow-rate').textContent = fmtGd(dailyFlow);

    const updatedAt = analyticsData.lastRun?.updatedAt
        ? new Date(analyticsData.lastRun.updatedAt).toLocaleString()
        : 'Unknown';
    document.getElementById('last-updated-text').textContent =
        'Last aggregation: ' + updatedAt + ' | Auto-refreshes every 5 min';
}

// === Rendering: Charts ===
function renderCharts() {
    const daily = analyticsData.daily.filter(d => !d.missing);
    if (daily.length === 0) {
        document.getElementById('charts-loading').innerHTML =
            '<div class="empty-state"><div class="emoji">&#128202;</div>' +
            '<p>No daily data yet. Charts will appear once activity starts.</p></div>';
        return;
    }

    document.getElementById('charts-loading').style.display = 'none';
    document.getElementById('charts-content').style.display = 'block';

    const dates = daily.map(d => d.date);
    const deposits = daily.map(d => weiToGd(d.gdOneTimeDepositsWei));
    const streamed = daily.map(d => weiToGd(d.gdStreamedWei));
    const credits = daily.map(d => weiToUsd(d.aiCreditsUsedWei));
    const gdBuyers = daily.map(d => d.uniqueGdBuyers);
    const creditUsers = daily.map(d => d.uniqueCreditUsers);

    const chartOpts = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { labels: { color: '#9aa0b0', font: { size: 11 } } },
            tooltip: {
                backgroundColor: 'rgba(34,37,56,0.95)',
                titleColor: '#e8eaed',
                bodyColor: '#9aa0b0',
                borderColor: '#2d3148',
                borderWidth: 1
            }
        },
        scales: {
            x: {
                ticks: { color: '#9aa0b0', maxRotation: 45, autoSkip: true, maxTicksLimit: 20, font: { size: 11 } },
                grid: { color: 'rgba(45,49,72,0.3)' }
            },
            y: {
                ticks: { color: '#9aa0b0', font: { size: 11 } },
                grid: { color: 'rgba(45,49,72,0.3)' },
                beginAtZero: true
            }
        }
    };

    // Chart 1: G$ Volume (stacked area)
    const volCtx = document.getElementById('volume-chart');
    if (window._chartVol) window._chartVol.destroy();
    window._chartVol = new Chart(volCtx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: [
                {
                    label: 'One-time Deposits (G$)',
                    data: deposits,
                    borderColor: 'rgba(0, 176, 255, 0.9)',
                    backgroundColor: 'rgba(0, 176, 255, 0.2)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    borderWidth: 2
                },
                {
                    label: 'Streamed (G$)',
                    data: streamed,
                    borderColor: 'rgba(124, 77, 255, 0.9)',
                    backgroundColor: 'rgba(124, 77, 255, 0.2)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    borderWidth: 2
                }
            ]
        },
        options: { ...chartOpts, plugins: { ...chartOpts.plugins, legend: { display: true, labels: { color: '#9aa0b0', font: { size: 11 } } } } }
    });

    // Chart 2: AI Credits bar
    const credCtx = document.getElementById('credits-chart');
    if (window._chartCred) window._chartCred.destroy();
    window._chartCred = new Chart(credCtx, {
        type: 'bar',
        data: {
            labels: dates,
            datasets: [{
                label: 'AI Credits (USD)',
                data: credits,
                backgroundColor: 'rgba(76, 175, 80, 0.5)',
                borderColor: 'rgba(76, 175, 80, 0.9)',
                borderWidth: 1,
                borderRadius: 2
            }]
        },
        options: { ...chartOpts, plugins: { ...chartOpts.plugins, legend: { display: false } } }
    });

    // Chart 3: Unique wallets line
    const walCtx = document.getElementById('wallets-chart');
    if (window._chartWal) window._chartWal.destroy();
    window._chartWal = new Chart(walCtx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: [
                {
                    label: 'G$ Buyers',
                    data: gdBuyers,
                    borderColor: 'rgba(0, 176, 255, 0.9)',
                    backgroundColor: 'rgba(0, 176, 255, 0.1)',
                    fill: false,
                    tension: 0.3,
                    pointRadius: 2,
                    borderWidth: 2
                },
                {
                    label: 'Credit Users',
                    data: creditUsers,
                    borderColor: 'rgba(255, 152, 0, 0.9)',
                    backgroundColor: 'rgba(255, 152, 0, 0.1)',
                    fill: false,
                    tension: 0.3,
                    pointRadius: 2,
                    borderWidth: 2
                }
            ]
        },
        options: { ...chartOpts, plugins: { ...chartOpts.plugins, legend: { display: true, labels: { color: '#9aa0b0', font: { size: 11 } } } } }
    });
}

// === Rendering: Table ===
function renderTable() {
    const daily = analyticsData.daily.filter(d => !d.missing);
    // Sort most recent first
    daily.sort((a, b) => b.date.localeCompare(a.date));

    totalPages = Math.max(1, Math.ceil(daily.length / TABLE_PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * TABLE_PAGE_SIZE;
    const pageData = daily.slice(start, start + TABLE_PAGE_SIZE);

    const container = document.getElementById('table-content');

    if (daily.length === 0) {
        container.innerHTML =
            '<div class="empty-state"><div class="emoji">&#128202;</div>' +
            '<p>No data recorded yet. The table will populate once transactions occur.</p></div>';
        document.getElementById('pagination').style.display = 'none';
        return;
    }

    let html = '<table class="data-table"><thead><tr>' +
        '<th>Date</th><th>G$ Deposited</th><th>G$ Streamed</th>' +
        '<th>Total G$</th><th>AI Credits (USD)</th>' +
        '<th>Wallets (G$)</th><th>Wallets (AI)</th>' +
        '</tr></thead><tbody>';

    pageData.forEach(row => {
        const dep = weiToGd(row.gdOneTimeDepositsWei);
        const str = weiToGd(row.gdStreamedWei);
        const total = dep + str;
        const cred = weiToUsd(row.aiCreditsUsedWei);

        html += '<tr>' +
            '<td>' + row.date + '</td>' +
            '<td>' + fmtNum(dep) + '</td>' +
            '<td>' + fmtNum(str) + '</td>' +
            '<td class="accent">' + fmtNum(total) + '</td>' +
            '<td class="accent">' + fmtUsd(cred) + '</td>' +
            '<td>' + row.uniqueGdBuyers + '</td>' +
            '<td>' + row.uniqueCreditUsers + '</td>' +
            '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
    renderPagination();
}

function renderPagination() {
    const paginationEl = document.getElementById('pagination');
    if (totalPages <= 1) {
        paginationEl.style.display = 'none';
        return;
    }
    paginationEl.style.display = 'flex';
    document.getElementById('page-info').textContent = 'Page ' + currentPage + ' of ' + totalPages;
    document.getElementById('page-first').disabled = currentPage <= 1;
    document.getElementById('page-prev').disabled = currentPage <= 1;
    document.getElementById('page-next').disabled = currentPage >= totalPages;
    document.getElementById('page-last').disabled = currentPage >= totalPages;
}

function goToPage(page) {
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    renderTable();
}

// === Init ===
async function init() {
    await loadData();
    // Auto-refresh every 5 minutes
    refreshTimer = setInterval(loadData, REFRESH_INTERVAL_MS);
}

init();

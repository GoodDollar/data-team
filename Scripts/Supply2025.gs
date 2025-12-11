const DUNE_API_KEY = 'ltfKMVa7B802YKRpMMvJjYWxE5k8i8Z1';
const API_CELOSCAN_KEY = 'A1P9FPWHR4DG3UXNEWW3EQWAVI6TT3U9P5'
const API_ETHERSCAN_KEY = 'RAN3ZE1H6RPIQIDTSFRT46AMDPR5CGTVJC';

const ENDPOINTS = {
  G$_SUPPLY_ETH_TOTAL: 'https://api.etherscan.io/v2/api?chainid=1&module=stats&action=tokensupply&contractaddress=0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B&apikey=' + API_ETHERSCAN_KEY,
  FROZEN_WALLET1: 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokenbalance&contractaddress=0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B&address=0xec577447d314cf1e443e9f4488216651450dbe7c&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  FROZEN_WALLET2: 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokenbalance&contractaddress=0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B&address=0x6738fa889ff31f82d9fe8862ec025dbe318f3fde&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  G$_SUPPLY_FUSE: 'https://explorer.fuse.io/api?module=stats&action=tokensupply&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC',
  G$_SUPPLY_CELO: 'https://explorer.celo.org/mainnet/api?module=stats&action=tokensupply&contractaddress=0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
  CELO_CLAIM: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  CELO_FAUCET: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x4F93Fa058b03953C851eFaA2e4FC5C34afDFAb84&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  CELO_OTP: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0xB27D247f5C2a61D2Cb6b6E67FEE51d839447e97d&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  FUSE_CLAIM: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0xd253A5203817225e9768C05E5996d642fb96bA86',
  FUSE_FAUCET: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0x01ab5966C1d742Ae0CFF7f14cC0F4D85156e83d9',
  FUSE_OTP: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0xd9Aa86e0Ddb932bD78ab8c71C1B98F83cF610Bd4',
  CELO_REP: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0xa9000Aa66903b5E26F88Fa8462739CdCF7956EA6&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  FUSE_REP: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0x603B8C0F110E037b51A381CBCacAbb8d6c6E4543',
  CELO_INVITE: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x36829D1Cda92FFF5782d5d48991620664FC857d3&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  FUSE_INVITE: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0xCa2F09c3ccFD7aD5cB9276918Bd1868f2b922ea0',
  ADMIN_WALLET: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x7119CD89D4792aF90277d84cDffa3F2Ab22a0022&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  CELO_AVATAR: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x495d133B938596C9984d462F007B676bDc57eCEC&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  DAO_CREATOR: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x76e76e10Ac308A1D54a00f9df27EdCE4801F288b&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  FUSE_AVATAR: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0xf96dADc6D71113F6500e97590760C924dA1eF70e',
  CELO_TREASURY: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x437c699887779d0a95ad6349cfde7dfa716c005d&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  FUSE_TREASURY: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0xCe69892CbDA078BbFAA3E5aE7A4b4d2Bf3E5c412',
  MENTO_RESERVE: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x94A3240f484A04F5e3d524f528d02694c109463b&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  GOV_STAKING: 'https://explorer.fuse.io/api?module=account&action=tokenbalance&contractaddress=0x495d133B938596C9984d462F007B676bDc57eCEC&address=0xB7C3e738224625289C573c54d402E9Be46205546',
  MPB: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0xa3247276DbCC76Dd7705273f766eB3E8a5ecF4a5&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  ETORO: 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokenbalance&contractaddress=0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B&address=0x61ec01ad0937ebc10d448d259a2bbb1556b61e38&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  CELO_GOODLABS: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x4e31993d9f13f940828bf9ec2f643a7e55b21e8c&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  ETH_GOODLABS: 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokenbalance&contractaddress=0x67C5870b4A41D4Ebef24d2456547A03F1f3e094B&address=0x571f39d351513146248acafa9d0509319a327c4d&tag=latest&apikey=' + API_ETHERSCAN_KEY,
  JOINT_SAFE: 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokenbalance&contractaddress=0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a&address=0x0d9b56076292ff706f7618498547837571fed7b6&tag=latest&apikey=' + API_ETHERSCAN_KEY
}

const QUERY_IDS = {
  whales: '5207920',
  supply: '5049656',
  reserve: '4969686'
};

const FUSE_WHALES = 1300000000; // 1 billion for G$ Supporters calculation
const SUPPLY_LIMIT_VALUE = 2200000000000; // 2.2 Trillion G$ fixed hardcoded supply limit

// --- HELPER FUNCTIONS ---
function _fetchDuneFullResult(queryId, parameters = []) {
  const execUrl = `https://api.dune.com/api/v1/query/${queryId}/execute`;

  try {
    console.log(`Attempting to execute Dune query ID (full result): ${queryId}`);
    const execRes = UrlFetchApp.fetch(execUrl, {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'X-Dune-API-Key': DUNE_API_KEY
      },
      payload: JSON.stringify({ parameters })
    });
    const { execution_id } = JSON.parse(execRes.getContentText());
    console.log(`Dune Query ${queryId} execution started with ID: ${execution_id}`);

    const maxRetries = 15;
    let delay = 2000;

    for (let i = 0; i < maxRetries; i++) {
      Utilities.sleep(delay);

      const resultUrl = `https://api.dune.com/api/v1/execution/${execution_id}/results`;
      const resultRes = UrlFetchApp.fetch(resultUrl, {
        headers: { 'X-Dune-API-Key': DUNE_API_KEY }
      });
      const json = JSON.parse(resultRes.getContentText());

      if (json.state === 'QUERY_STATE_COMPLETED') {
        console.log(`Dune Query ${queryId} completed. Retrieved ${json.result.rows.length} rows.`);
        return json.result; // Return the full result object
      } else if (json.state === 'QUERY_STATE_FAILED') {
        throw new Error(`Dune query ${queryId} failed: ${json.error}`);
      }

      delay *= 2;
      if (delay > 60 * 1000) {
        delay = 60 * 1000;
      }
      console.log(`Dune Query ${queryId} still pending. Retrying in ${delay / 1000} seconds...`);
    }

    throw new Error(`Dune query ${queryId} timed out after exponential backoff.`);
  } catch (error) {
    console.error(`Error fetching Dune query ${queryId} (full result): ${error.toString()}`);
    throw error;
  }
}

function fetchCeloHistoricalSupplyDataFromDune() {
  console.log("Attempting to fetch historical Celo G$ Supply data from Dune Analytics using QUERY_IDS.supply...");
  try {
    const duneResult = _fetchDuneFullResult(QUERY_IDS.supply);

    const headers = duneResult.metadata.column_names;
    const rows = duneResult.rows;

    // Convert array of objects to array of arrays, preserving order of headers
    const dataAsArrays = rows.map(row => {
      return headers.map(header => {
        // Convert BigInts to Number if necessary, which can happen with Dune data
        const value = row[header];
        if (typeof value === 'bigint') {
          return Number(value);
        }
        return value;
      });
    });

    console.log(`Successfully fetched ${dataAsArrays.length} rows of historical Celo data.`);
    return { headers: headers, data: dataAsArrays };

  } catch (error) {
    console.error(`Failed to fetch historical Celo supply data: ${error.toString()}`);
    // Return empty data structure on failure, so update function doesn't erase existing sheet
    return { headers: [], data: [] };
  }
}

function updateCeloHistoricalSupplySheet() {
  const SHEET_NAME = "Celo Supply";
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    console.error(`Sheet named "${SHEET_NAME}" not found. Please create a sheet named "${SHEET_NAME}" first.`);
    SpreadsheetApp.getUi().alert(`Error: Sheet named "${SHEET_NAME}" not found. Please create a sheet named "${SHEET_NAME}"`);
    return;
  }

  console.log(`--- Starting update for sheet: ${SHEET_NAME} ---`);

  // 1. Fetch data
  const { headers, data } = fetchCeloHistoricalSupplyDataFromDune();

  // 2. Check if data retrieval was successful and if there's data to write
  if (!headers || headers.length === 0 || !data || data.length === 0) {
    console.warn("No valid headers or data received from Dune query. Sheet will not be updated to prevent erasure.");
    SpreadsheetApp.getUi().alert("Warning: No new historical Celo supply data received. Sheet not updated.");
    return;
  }

  try {
    // 3. If data is valid, proceed with updating the sheet

    // Write Headers to Row 1
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    console.log("Headers populated successfully.");

    // Clear existing data rows (from row 2 downwards)
    const lastRowToClear = sheet.getLastRow();
    if (lastRowToClear >= 2) {
      sheet.getRange(2, 1, lastRowToClear - 1, headers.length).clearContent();
      console.log(`Cleared previous data from row 2 to ${lastRowToClear}.`);
    }

    // Write new data to the sheet, starting from Row 2
    sheet.getRange(2, 1, data.length, data[0].length).setValues(data);
    console.log(`Successfully populated ${data.length} historical rows to "${SHEET_NAME}".`);

  } catch (error) {
    console.error(`Error updating "${SHEET_NAME}" sheet after data fetch: ${error.toString()}`);
    SpreadsheetApp.getUi().alert(`Error updating "${SHEET_NAME}" sheet: ${error.message}`);
  }
  console.log(`--- Finished update for sheet: ${SHEET_NAME} ---`);
}

/**
 * Parses a locale-formatted string number (e.g., "1,234.56") into a float.
 * @param {string} formattedString The string to parse.
 * @returns {number} The parsed number, or 0 if parsing fails.
 */
function parseFormattedNumber(formattedString) {
  if (typeof formattedString !== 'string') {
    return 0;
  }
  const cleanedString = formattedString.replace(/,/g, ''); // Remove thousand separators
  const parsed = parseFloat(cleanedString);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Formats a number to a locale string with 0 decimal places and thousand separators for display in the sheet.
 * This is based on your last provided script which uses `minimumFractionDigits: 0, maximumFractionDigits: 0`
 * for the main Supply sheet outputs.
 * @param {number} num The number to format.
 * @returns {string} The formatted string.
 */
function formatNumberForSheet(num) {
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    useGrouping: true
  });
}

/**
 * Fetches data from a Dune Analytics query.
 * Implements exponential backoff to wait for query completion.
 * @param {string} queryId The ID of the Dune query.
 * @param {Array} parameters Optional array of query parameters.
 * @return {Array<Object>} An array of row objects from the Dune query result.
 * @throws {Error} If the Dune query times out or fails.
 */
function fetchDuneQuery(queryId, parameters = []) {
  const execUrl = `https://api.dune.com/api/v1/query/${queryId}/execute`;

  try {
    console.log(`Attempting to execute Dune query ID: ${queryId}`);
    const execRes = UrlFetchApp.fetch(execUrl, {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'X-Dune-API-Key': DUNE_API_KEY
      },
      payload: JSON.stringify({ parameters })
    });
    const { execution_id } = JSON.parse(execRes.getContentText());
    console.log(`Dune Query ${queryId} execution started with ID: ${execution_id}`);

    const maxRetries = 15;
    let delay = 2000;

    for (let i = 0; i < maxRetries; i++) {
      Utilities.sleep(delay);

      const resultUrl = `https://api.dune.com/api/v1/execution/${execution_id}/results`;
      const resultRes = UrlFetchApp.fetch(resultUrl, {
        headers: { 'X-Dune-API-Key': DUNE_API_KEY }
      });
      const json = JSON.parse(resultRes.getContentText());

      if (json.state === 'QUERY_STATE_COMPLETED') {
        console.log(`Dune Query ${queryId} completed. Retrieved ${json.result.rows.length} rows.`);
        return json.result.rows;
      } else if (json.state === 'QUERY_STATE_FAILED') {
        throw new Error(`Dune query ${queryId} failed: ${json.error}`);
      }

      delay *= 2;
      if (delay > 60 * 1000) {
        delay = 60 * 1000;
      }
      console.log(`Dune Query ${queryId} still pending. Retrying in ${delay / 1000} seconds...`);
    }

    throw new Error(`Dune query ${queryId} timed out after exponential backoff.`);
  } catch (error) {
    console.error(`Error fetching Dune query ${queryId}: ${error.toString()}`);
    throw error;
  }
}

/**
 * Fetches G$ Supporter (Whales) and User data from Dune using the predefined query.
 * @return {object} An object containing raw G_SUPPORTERS and USERS values.
 */
function getCeloWhalesAndUsers() {
  let G_SUPPORTERS = 0; // Value for "Supporters" based on Dune query
  let USERS = 0;        // Value for "Other Celo Users" based on Dune query

  try {
    const data = fetchDuneQuery(QUERY_IDS.whales);

    // Assuming the Dune query returns two rows in a specific order:
    // data[0] for Supporters/Whales, data[1] for regular users.
    G_SUPPORTERS = data[0]?.total_g_tokens_held ?? 0;
    USERS = data[1]?.total_g_tokens_held ?? 0;

    console.log('Dune G$ Supporters (from query result): G$' + G_SUPPORTERS);
    console.log('Dune Users (from query result): G$' + USERS);

  } catch (error) {
    console.error(`Failed to get Celo Whales and Users from Dune: ${error.toString()}`);
  }
  return { G_SUPPORTERS: Number(G_SUPPORTERS), USERS: Number(USERS) };
}

/**
function fetchAndFormatApiData() {
  const formattedData = {};
  const today = new Date();
  formattedData.Date = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");
  console.log(`--- Starting API data fetch, normalization, and formatting for ${formattedData.Date} ---`);

  for (const key in ENDPOINTS) {
    if (ENDPOINTS.hasOwnProperty(key)) {
      const url = ENDPOINTS[key];
      let valueToStore = "0.00"; // Default to a formatted zero on error or missing data

      try {
        const response = UrlFetchApp.fetch(url);
        const json = JSON.parse(response.getContentText());

        if (json.result !== undefined && json.result !== null) {
          const rawValue = json.result;

          const decimals = (url.includes('celoscan.io') || url.includes('explorer.celo.org')) ? 18 : 2;
          const divisor = Math.pow(10, decimals);

          let normalizedValue;
          try {
            const bigIntValue = BigInt(rawValue);
            normalizedValue = Number(bigIntValue) / divisor;
          } catch (e) {
            normalizedValue = parseFloat(rawValue) / divisor;
            console.warn(`    Could not parse ${key} raw value '${rawValue}' as BigInt, falling back to parseFloat. Error: ${e}`);
          }

          valueToStore = normalizedValue.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
            useGrouping: true
          });

          console.log(`    Successfully fetched ${key}. Raw: '${rawValue}', Normalized (${decimals} decimals): ${normalizedValue}, Formatted: '${valueToStore}'`);
        } else if (json.message) {
          console.warn(`    API call for ${key} returned a message (not a result): ${json.message}. Storing '0.00'.`);
        } else {
          console.warn(`    API call for ${key} returned no 'result' field. Full response: ${JSON.stringify(json)}. Storing '0.00'.`);
        }
      } catch (e) {
        console.error(`    Error fetching data for ${key} from ${url}: ${e.toString()}. Storing '0.00'.`);
      }
      formattedData[key] = valueToStore;
    }
  }
  console.log("--- Finished API data fetch, normalization, and formatting ---");
  console.log("Final Formatted Data Object:", formattedData);
  return formattedData;
}
*/

function fetchAndFormatApiData() {
  const formattedData = {};
  const today = new Date();
  formattedData.Date = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");
  console.log(`--- Starting API data fetch, normalization, and formatting for ${formattedData.Date} ---`);

  // Helper: decide decimals by chain / endpoint
  function inferDecimals(url, key) {
    // 1) Chain-aware for Etherscan V2
    const m = url.match(/(?:\?|&)chainid=(\d+)/);
    if (m) {
      const chain = m[1];
      if (chain === '42220') return 18; // Celo G$ is 18 decimals
      if (chain === '1')     return 2;  // ETH G$ uses 2 decimals in your sheet logic
      // Add more networks here if you later use V2 for them.
    }
    // 2) Celo explorer (legacy direct)
    if (url.includes('explorer.celo.org')) return 18;
    // 3) Fuse explorer (GoodDollar G$ on Fuse)
    if (url.includes('explorer.fuse.io')) return 2;
    // 4) Fallback by key (safety net for specific totals)
    if (key === 'G$_SUPPLY_CELO') return 18;
    // Default heuristic (ETH/Fuse legacy)
    return 2;
  }

  for (const key in ENDPOINTS) {
    if (!ENDPOINTS.hasOwnProperty(key)) continue;
    const url = ENDPOINTS[key];
    let valueToStore = "0.00";

    try {
      const response = UrlFetchApp.fetch(url);
      const json = JSON.parse(response.getContentText());

      if (json.result !== undefined && json.result !== null) {
        const rawValue = json.result;
        const decimals = inferDecimals(url, key);
        const divisor = Math.pow(10, decimals);

        let normalizedValue;
        try {
          const bigIntValue = BigInt(rawValue);
          // Avoid precision loss for very big ints: split division using strings if needed
          // but in practice Number(bigInt)/divisor is fine for display-level precision here:
          normalizedValue = Number(bigIntValue) / divisor;
        } catch (e) {
          normalizedValue = parseFloat(rawValue) / divisor;
          console.warn(`    Could not parse ${key} raw value '${rawValue}' as BigInt, falling back to parseFloat. Error: ${e}`);
        }

        valueToStore = normalizedValue.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
          useGrouping: true
        });

        console.log(`    Successfully fetched ${key}. Raw: '${rawValue}', Normalized (${decimals} decimals): ${normalizedValue}, Formatted: '${valueToStore}'`);
      } else if (json.message) {
        console.warn(`    API call for ${key} returned a message (not a result): ${json.message}. Storing '0.00'.`);
      } else {
        console.warn(`    API call for ${key} returned no 'result' field. Full response: ${JSON.stringify(json)}. Storing '0.00'.`);
      }
    } catch (e) {
      console.error(`    Error fetching data for ${key} from ${url}: ${e.toString()}. Storing '0.00'.`);
    }
    formattedData[key] = valueToStore;
  }

  console.log("--- Finished API data fetch, normalization, and formatting ---");
  console.log("Final Formatted Data Object:", formattedData);
  return formattedData;
}


/**
 * Main function to fetch all GoodDollar metrics, perform calculations,
 * and write the data to the Google Sheet.
 * This function will either overwrite the last row if the date matches today,
 * or append a new row if the date is older or the sheet is empty.
 */
function updateSupplySheet() {
  const MAIN_SHEET_NAME = "Supply";
  const MINTED_VS_LIMIT_SHEET_NAME = "Minted vs Limit";
  const FROZEN_VS_CIRC_SHEET_NAME = "Frozen vs Circulating";
  const BY_NETWORK_SHEET_NAME = "by Network";
  const BY_CATEGORY_SHEET_NAME = "by Category";


  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mainSheet = ss.getSheetByName(MAIN_SHEET_NAME);

  if (!mainSheet) {
    console.error(`Sheet named "${MAIN_SHEET_NAME}" not found. Please check the sheet name.`);
    SpreadsheetApp.getUi().alert(`Error: Sheet named "${MAIN_SHEET_NAME}" not found. Script cannot proceed.`);
    return;
  }

  console.log(`--- Starting full data update for sheet: ${MAIN_SHEET_NAME} and Looker Studio sheets ---`);

  // 1. Fetch data from Etherscan/Celoscan/Fuse APIs
  const apiData = fetchAndFormatApiData();

  // 2. Fetch data from Dune using your provided function
  const duneData = getCeloWhalesAndUsers();

  // 3. Perform calculations and prepare data for the main sheet and LS sheets
  const today = new Date();
  const todayFormatted = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");

  let TOTAL_FROZEN_RAW = 0;
  const frozen1 = parseFormattedNumber(apiData.FROZEN_WALLET1);
  const frozen2 = parseFormattedNumber(apiData.FROZEN_WALLET2);

  if (!isNaN(frozen1)) TOTAL_FROZEN_RAW += frozen1;
  if (!isNaN(frozen2)) TOTAL_FROZEN_RAW += frozen2;

  const G_SUPPLY_ETH_TOTAL_NUM = parseFormattedNumber(apiData['G$_SUPPLY_ETH_TOTAL']);
  let G_SUPPLY_ETH_CALCULATED_NUM = 0; // This is the 'G$ Circulating Supply on ETH' numeric value
  if (!isNaN(G_SUPPLY_ETH_TOTAL_NUM)) {
    G_SUPPLY_ETH_CALCULATED_NUM = G_SUPPLY_ETH_TOTAL_NUM - TOTAL_FROZEN_RAW;
  }

  const TOTAL_FROZEN_FORMATTED = formatNumberForSheet(TOTAL_FROZEN_RAW);
  const G_SUPPLY_ETH_FORMATTED = formatNumberForSheet(G_SUPPLY_ETH_CALCULATED_NUM);

  // G$ Supporters calculation (includes FUSE_WHALES and Dune's G_SUPPORTERS)
  const G_SUPPORTERS_CALCULATED = (duneData.G_SUPPORTERS || 0) + FUSE_WHALES;
  const G_SUPPORTERS_FORMATTED = formatNumberForSheet(G_SUPPORTERS_CALCULATED);

  // --- Calculate sum for Contract Categories ---
  const coreContractsSum =
    parseFormattedNumber(apiData.CELO_CLAIM) +
    parseFormattedNumber(apiData.CELO_FAUCET) +
    parseFormattedNumber(apiData.CELO_OTP) +
    parseFormattedNumber(apiData.FUSE_CLAIM) +
    parseFormattedNumber(apiData.FUSE_FAUCET) +
    parseFormattedNumber(apiData.FUSE_OTP) +
    parseFormattedNumber(apiData.CELO_REP) +
    parseFormattedNumber(apiData.FUSE_REP) +
    parseFormattedNumber(apiData.CELO_INVITE) +
    parseFormattedNumber(apiData.GOV_STAKING) +
    parseFormattedNumber(apiData.FUSE_INVITE);
  const coreContractsFormatted = formatNumberForSheet(coreContractsSum);

  const daoTreasurySum =
    parseFormattedNumber(apiData.ADMIN_WALLET) +
    parseFormattedNumber(apiData.CELO_AVATAR) +
    parseFormattedNumber(apiData.DAO_CREATOR) +
    parseFormattedNumber(apiData.FUSE_AVATAR) +
    parseFormattedNumber(apiData.CELO_TREASURY) +
    parseFormattedNumber(apiData.FUSE_TREASURY) +
    parseFormattedNumber(apiData.MENTO_RESERVE);
  const daoTreasuryFormatted = formatNumberForSheet(daoTreasurySum);

  const ecosystemContractsSum =
    parseFormattedNumber(apiData.MPB);
  const ecosystemContractsFormatted = formatNumberForSheet(ecosystemContractsSum);

  const sponsorHoldingsSum =
    parseFormattedNumber(apiData.ETORO) +
    parseFormattedNumber(apiData.CELO_GOODLABS) +
    parseFormattedNumber(apiData.ETH_GOODLABS) +
    parseFormattedNumber(apiData.JOINT_SAFE);
  const sponsorHoldingsFormatted = formatNumberForSheet(sponsorHoldingsSum);


  // --- CALCULATIONS FOR TOTAL SUPPLY AND BALANCING USER WALLETS ---

  // G$_TOTAL_SUPPLY = G$_SUPPLY_ETH_TOTAL + G$_SUPPLY_FUSE + G$_SUPPLY_CELO
  const G_SUPPLY_FUSE_NUM = parseFormattedNumber(apiData['G$_SUPPLY_FUSE']);
  const G_SUPPLY_CELO_NUM = parseFormattedNumber(apiData['G$_SUPPLY_CELO']);
  const G_TOTAL_SUPPLY_CALCULATED = G_SUPPLY_ETH_TOTAL_NUM + G_SUPPLY_FUSE_NUM + G_SUPPLY_CELO_NUM;
  const G_TOTAL_SUPPLY_FORMATTED = formatNumberForSheet(G_TOTAL_SUPPLY_CALCULATED);

  // SUPPLY_LIMIT (hardcoded)
  const SUPPLY_LIMIT_FORMATTED = formatNumberForSheet(SUPPLY_LIMIT_VALUE);

  // --- Calculate TOTAL_USER_WALLETS as the balancing figure ---
  const TOTAL_USER_WALLETS_NUMERIC = G_TOTAL_SUPPLY_CALCULATED - (
    TOTAL_FROZEN_RAW +
    coreContractsSum +
    daoTreasurySum +
    ecosystemContractsSum +
    sponsorHoldingsSum +
    G_SUPPORTERS_CALCULATED
  );

  // Format the combined user wallet figure for the sheet
  const TOTAL_USER_WALLETS_FORMATTED = formatNumberForSheet(TOTAL_USER_WALLETS_NUMERIC);
  // --- End of balancing calculation ---


  // Data array for the main "Supply" sheet row - ENSURE THE ORDER MATCHES YOUR SPREADSHEET HEADERS
  const mainSheetRowData = [
    todayFormatted,
    apiData['G$_SUPPLY_ETH_TOTAL'],
    TOTAL_FROZEN_FORMATTED,
    G_SUPPLY_ETH_FORMATTED, // G$ Circulating Supply on ETH
    apiData['G$_SUPPLY_FUSE'],
    apiData['G$_SUPPLY_CELO'],
    G_TOTAL_SUPPLY_FORMATTED, // Total Supply
    SUPPLY_LIMIT_FORMATTED, // Supply Limit
    coreContractsFormatted,
    daoTreasuryFormatted,
    ecosystemContractsFormatted,
    sponsorHoldingsFormatted,
    G_SUPPORTERS_FORMATTED,
    TOTAL_USER_WALLETS_FORMATTED
  ];

  // 4. Implement "overwrite or append" logic for the MAIN "Supply" sheet
  const lastRow = mainSheet.getLastRow();
  let targetRow;

  if (lastRow > 0) {
    const lastRowDateRange = mainSheet.getRange(lastRow, 1); // Assumes date is in column A (1)
    const lastRowDateValue = lastRowDateRange.getDisplayValue(); // Get formatted string value

    if (lastRowDateValue === todayFormatted) {
      targetRow = lastRow;
      console.log(`Date in last row (${lastRowDateValue}) matches today (${todayFormatted}). Overwriting row ${targetRow} of ${MAIN_SHEET_NAME}.`);
    } else {
      targetRow = lastRow + 1;
      console.log(`Date in last row (${lastRowDateValue}) is older than today (${todayFormatted}). Appending new row ${targetRow} to ${MAIN_SHEET_NAME}.`);
    }
  } else {
    targetRow = 2; // Assuming headers are in row 1, start data from row 2
    console.log(`Sheet is empty or has only headers. Appending data to row ${targetRow} of ${MAIN_SHEET_NAME}.`);
  }

  // Write data to the main "Supply" sheet
  mainSheet.getRange(targetRow, 1, 1, mainSheetRowData.length).setValues([mainSheetRowData]);
  console.log("Data successfully written to main 'Supply' sheet.");


  // --- START: Update Looker Studio specific sheets ---

  const sheetsToUpdate = [
    {
      name: MINTED_VS_LIMIT_SHEET_NAME,
      data: [
        ["Minted", G_TOTAL_SUPPLY_CALCULATED],
        ["Supply Limit", SUPPLY_LIMIT_VALUE]
      ]
    },
    {
      name: FROZEN_VS_CIRC_SHEET_NAME,
      data: [
        ["Circulating", (G_SUPPLY_ETH_CALCULATED_NUM + G_SUPPLY_FUSE_NUM + G_SUPPLY_CELO_NUM)],
        ["Frozen", TOTAL_FROZEN_RAW],
        ["Total Supply", G_TOTAL_SUPPLY_CALCULATED]
      ]
    },
    {
      name: BY_NETWORK_SHEET_NAME,
      data: [
        ["Ethereum", G_SUPPLY_ETH_CALCULATED_NUM],
        ["Fuse", G_SUPPLY_FUSE_NUM],
        ["Celo", G_SUPPLY_CELO_NUM]
      ]
    },
    {
      name: BY_CATEGORY_SHEET_NAME,
      data: [
        ["Core Contracts", coreContractsSum],
        ["DAO Treasury", daoTreasurySum],
        ["Ecosystem Contracts", ecosystemContractsSum],
        ["Sponsor Holdings", sponsorHoldingsSum],
        ["G$ Supporters", G_SUPPORTERS_CALCULATED],
        ["User Wallets", TOTAL_USER_WALLETS_NUMERIC] // Use the numeric value here for consistency
      ]
    }
  ];

  sheetsToUpdate.forEach(sheetInfo => {
    const lsSheet = ss.getSheetByName(sheetInfo.name);
    if (!lsSheet) {
      console.error(`Looker Studio sheet "${sheetInfo.name}" not found. Skipping update for this sheet.`);
      return;
    }

    console.log(`Updating Looker Studio sheet: "${sheetInfo.name}"`);

    // Clear existing content (from A1 to last cell with content)
    // Use clearContents() to remove values, formulas, and formatting (optional, but safer)
    lsSheet.clearContents();

    // Set new data. The range starts from A1 (1,1) and covers the dimensions of the data array.
    lsSheet.getRange(1, 1, sheetInfo.data.length, sheetInfo.data[0].length).setValues(sheetInfo.data);
    console.log(`Successfully updated sheet: "${sheetInfo.name}" with ${sheetInfo.data.length} rows.`);
  });

  // --- END: Update Looker Studio specific sheets ---

  console.log("All data updates completed.");
}

/**
 * Entry point for testing the main function.
 * You would typically set up a time-driven trigger for updateSupplySheet.
 */
function runGoodDollarMetricsUpdate() {
  updateSupplySheet();
}
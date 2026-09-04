$ErrorActionPreference = 'Stop'

$XdcReserveSubgraph = 'https://api.goldsky.com/api/public/project_cmizuamdtfouu01x4csuk5dk1/subgraphs/reserve_xdc/v1.0.0/gn'
$XdcRpc = 'https://rpc.xinfin.network'
$FuseApi = 'https://explorer.fuse.io/api/v2'

$XdcStart = [datetimeoffset]'2026-09-04T04:06:58Z'
$XdcEnd = [datetimeoffset]'2026-09-04T13:43:31Z'
$FuseStart = [datetimeoffset]'2026-09-03T00:00:00Z'
$FuseEnd = [datetimeoffset]'2026-09-04T12:00:00Z'

$FuseGd = '0x495d133b938596c9984d462f007b676bdc57ecec'
$FuseRouters = @(
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
  '0xa3247276dbcc76dd7705273f766eb3e8a5ecf4a5',
  '0xfb152fc469a3e9154f8aa60bbd6700ecbc357a54'
)

function Invoke-JsonRpc {
  param(
    [string]$Uri,
    [string]$Method,
    [object[]]$Params
  )

  $payload = @{
    jsonrpc = '2.0'
    method = $Method
    params = $Params
    id = 1
  } | ConvertTo-Json -Compress

  return Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json' -Body $payload
}

function Get-XdcReserveEvents {
  $startTs = $XdcStart.ToUnixTimeSeconds()
  $endTs = $XdcEnd.ToUnixTimeSeconds()

  $query = "query { reservePrices(first: 200, orderBy: timestamp, orderDirection: asc, where: { timestamp_gte: `"$startTs`", timestamp_lte: `"$endTs`" }) { id amountOut timestamp price } }"
  $body = @{ query = $query } | ConvertTo-Json -Compress
  $resp = Invoke-RestMethod -Method Post -Uri $XdcReserveSubgraph -ContentType 'application/json' -Body $body

  $rows = @()
  foreach ($r in $resp.data.reservePrices) {
    $tx = ($r.id -split '-')[0]
    $rows += [pscustomobject]@{
      txHash = $tx
      amountOut = [double]$r.amountOut / 1e6
      timestamp = [int64]$r.timestamp
      priceRaw = [double]$r.price
    }
  }

  return $rows
}

function Get-XdcSellerAttribution {
  param([array]$Events)

  $agg = @{}
  foreach ($e in $Events) {
    $tx = Invoke-JsonRpc -Uri $XdcRpc -Method 'eth_getTransactionByHash' -Params @($e.txHash)
    $seller = ($tx.result.from).ToLower()
    if (-not $agg.ContainsKey($seller)) {
      $agg[$seller] = [pscustomobject]@{
        seller = $seller
        outflow = 0.0
        txHashes = New-Object System.Collections.Generic.List[string]
      }
    }

    $agg[$seller].outflow += $e.amountOut
    $agg[$seller].txHashes.Add($e.txHash)
  }

  return $agg.Values |
    ForEach-Object {
      [pscustomobject]@{
        seller = $_.seller
        outflow = [math]::Round($_.outflow, 6)
        txCount = $_.txHashes.Count
        txHashes = $_.txHashes
      }
    } |
    Sort-Object outflow -Descending
}

function Get-FuseTransfers {
  param([string]$Router)

  $all = @()
  $cursor = $null
  for ($i = 0; $i -lt 120; $i++) {
    $url = "$FuseApi/addresses/$Router/token-transfers?type=ERC-20"
    if ($cursor) {
      $url += "&block_number=$($cursor.block_number)&index=$($cursor.index)"
    }

    $resp = Invoke-RestMethod -Method Get -Uri $url
    if (-not $resp.items -or $resp.items.Count -eq 0) {
      break
    }

    $stop = $false
    foreach ($it in $resp.items) {
      $ts = [datetimeoffset]$it.timestamp
      if ($ts -lt $FuseStart) {
        $stop = $true
        break
      }
      if ($ts -gt $FuseEnd) {
        continue
      }

      $from = ($it.from.hash).ToLower()
      $to = ($it.to.hash).ToLower()
      $token = ($it.token.address_hash).ToLower()

      if ($from -ne $Router.ToLower()) {
        continue
      }
      if ($token -eq $FuseGd) {
        continue
      }

      $decimals = [int]$it.total.decimals
      $amount = [double]$it.total.value / [math]::Pow(10, $decimals)

      $all += [pscustomobject]@{
        router = $Router.ToLower()
        timestamp = $it.timestamp
        txHash = $it.transaction_hash
        recipient = $to
        token = $token
        symbol = $it.token.symbol
        amount = $amount
      }
    }

    if ($stop) {
      break
    }

    if (-not $resp.next_page_params) {
      break
    }

    $cursor = $resp.next_page_params
  }

  return $all
}

function Get-FuseTop2 {
  $rows = @()
  foreach ($router in $FuseRouters) {
    $rows += Get-FuseTransfers -Router $router
  }

  $grouped = $rows |
    Group-Object recipient |
    ForEach-Object {
      $tokenBreakdown = $_.Group |
        Group-Object token,symbol |
        ForEach-Object {
          $parts = $_.Name -split ', '
          [pscustomobject]@{
            token = $parts[0].ToLower()
            symbol = $parts[1]
            amount = [math]::Round((($_.Group | Measure-Object amount -Sum).Sum), 6)
          }
        } |
        Sort-Object amount -Descending

      [pscustomobject]@{
        recipient = $_.Name
        total = [math]::Round((($_.Group | Measure-Object amount -Sum).Sum), 6)
        txCount = ($_.Group | Select-Object -ExpandProperty txHash -Unique).Count
        txHashes = @($_.Group | Select-Object -ExpandProperty txHash -Unique)
        tokenBreakdown = @($tokenBreakdown)
      }
    } |
    Sort-Object total -Descending

  return [pscustomobject]@{
    startIso = $FuseStart.UtcDateTime.ToString('o')
    endIso = $FuseEnd.UtcDateTime.ToString('o')
    routeOutflowRows = $rows.Count
    top2 = ($grouped | Select-Object -First 2)
  }
}

$xdcEvents = Get-XdcReserveEvents
$xdcSellers = Get-XdcSellerAttribution -Events $xdcEvents
$fuse = Get-FuseTop2

$result = [pscustomobject]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  sources = [pscustomobject]@{
    xdcReserveSubgraph = $XdcReserveSubgraph
    xdcRpc = $XdcRpc
    fuseExplorerApi = $FuseApi
  }
  xdc = [pscustomobject]@{
    windowStart = $XdcStart.UtcDateTime.ToString('o')
    windowEnd = $XdcEnd.UtcDateTime.ToString('o')
    reserveSwapEvents = $xdcEvents.Count
    totalReserveOutflow = [math]::Round((($xdcEvents | Measure-Object amountOut -Sum).Sum), 6)
    sellers = $xdcSellers
  }
  fuse = $fuse
}

$result | ConvertTo-Json -Depth 8

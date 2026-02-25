$BASE = 'http://localhost:8080/api'
$pass = 0
$fail = 0

function Check([string]$name, [bool]$cond) {
    if ($cond) { Write-Host "[PASS] $name"; $script:pass++ }
    else       { Write-Host "[FAIL] $name"; $script:fail++ }
}

function Post([string]$url, [string]$body) {
    try {
        return (Invoke-WebRequest -Uri $url -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -ErrorAction Stop).StatusCode
    } catch {
        return [int]$_.Exception.Response.StatusCode
    }
}

Write-Host "--- Req7: Create Account ---"
$body1 = '{"accountId":"qa-acc-001","ownerName":"Alice","initialBalance":0,"currency":"USD"}'
$s = Post "$BASE/accounts" $body1
Check 'Create account returns 202' ($s -eq 202)
$s2 = Post "$BASE/accounts" $body1
Check 'Duplicate create returns 409' ($s2 -eq 409)

Write-Host "--- Req8: Deposit ---"
$dep1 = '{"amount":100,"description":"Salary","transactionId":"d-001"}'
$s = Post "$BASE/accounts/qa-acc-001/deposit" $dep1
Check 'Deposit returns 202' ($s -eq 202)

$depBad = '{"amount":-5,"transactionId":"d-bad"}'
$s = Post "$BASE/accounts/qa-acc-001/deposit" $depBad
Check 'Deposit negative amount returns 400' ($s -eq 400)

$s = Post "$BASE/accounts/no-such/deposit" $dep1
Check 'Deposit nonexistent account returns 404' ($s -eq 404)

Write-Host "--- Req9: Withdraw ---"
$wd1 = '{"amount":40,"description":"Rent","transactionId":"w-001"}'
$s = Post "$BASE/accounts/qa-acc-001/withdraw" $wd1
Check 'Withdraw 40 returns 202' ($s -eq 202)

$wd2 = '{"amount":999,"description":"Big","transactionId":"w-002"}'
$s = Post "$BASE/accounts/qa-acc-001/withdraw" $wd2
Check 'Over-withdraw returns 409' ($s -eq 409)

Write-Host "--- Req11: Get Account ---"
$acc = Invoke-RestMethod -Uri "$BASE/accounts/qa-acc-001" -UseBasicParsing
Check 'GetAccount balance=60' ($acc.balance -eq 60)
Check 'GetAccount status=OPEN' ($acc.status -eq 'OPEN')
Check 'GetAccount currency=USD' ($acc.currency -eq 'USD')

Write-Host "--- Req12: Get Events ---"
$evts = Invoke-RestMethod -Uri "$BASE/accounts/qa-acc-001/events" -UseBasicParsing
Check 'GetEvents returns 3 events' ($evts.Count -eq 3)
Check 'Events in ascending order' ($evts[0].eventType -eq 'AccountCreated')

Write-Host "--- Req10: Close Account ---"
$cl = '{"reason":"test"}'
$s = Post "$BASE/accounts/qa-acc-001/close" $cl
Check 'Close with balance returns 409' ($s -eq 409)

$wd3 = '{"amount":60,"description":"Drain","transactionId":"w-003"}'
Post "$BASE/accounts/qa-acc-001/withdraw" $wd3 | Out-Null
$s = Post "$BASE/accounts/qa-acc-001/close" $cl
Check 'Close with zero balance returns 202' ($s -eq 202)

# Closed account deposit should return 409
$dep2 = '{"amount":10,"description":"x","transactionId":"d-002"}'
$s = Post "$BASE/accounts/qa-acc-001/deposit" $dep2
Check 'Deposit to closed account returns 409' ($s -eq 409)

Write-Host "--- Req13: Time-Travel ---"
$body3 = '{"accountId":"qa-tt","ownerName":"TT","initialBalance":0,"currency":"USD"}'
Post "$BASE/accounts" $body3 | Out-Null
$d1 = '{"amount":100,"description":"d1","transactionId":"tt-1"}'
Post "$BASE/accounts/qa-tt/deposit" $d1 | Out-Null
Start-Sleep -Milliseconds 500
$T1 = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
Start-Sleep -Milliseconds 500
$d2 = '{"amount":50,"description":"d2","transactionId":"tt-2"}'
Post "$BASE/accounts/qa-tt/deposit" $d2 | Out-Null
$tsEnc = [Uri]::EscapeDataString($T1)
$ttR = Invoke-RestMethod -Uri "$BASE/accounts/qa-tt/balance-at/$tsEnc" -UseBasicParsing
Check 'Time-travel balance at T1=100' ($ttR.balanceAt -eq 100)

Write-Host "--- Req14: Paginated Transactions ---"
$body4 = '{"accountId":"qa-pg","ownerName":"PG","initialBalance":0,"currency":"USD"}'
Post "$BASE/accounts" $body4 | Out-Null
for ($i=1; $i -le 12; $i++) {
    $pd = '{"amount":10,"description":"dep","transactionId":"pg-' + $i + '"}'
    Post "$BASE/accounts/qa-pg/deposit" $pd | Out-Null
}
$pg = Invoke-RestMethod -Uri "$BASE/accounts/qa-pg/transactions?page=2&pageSize=10" -UseBasicParsing
Check 'Pagination: page2 has 2 items' ($pg.items.Count -eq 2)
Check 'Pagination: currentPage=2' ($pg.currentPage -eq 2)
Check 'Pagination: totalCount=12' ($pg.totalCount -eq 12)

Write-Host "--- Req16: Projection Status ---"
$st = Invoke-RestMethod -Uri "$BASE/projections/status" -UseBasicParsing
Check 'Status has totalEventsInStore>0' ($st.totalEventsInStore -gt 0)
Check 'Status has 2 projections' ($st.projections.Count -eq 2)
$laggy = ($st.projections | Where-Object { $_.lag -gt 0 }).Count
Check 'Projections lag=0' ($laggy -eq 0)

Write-Host "--- Req15: Projection Rebuild ---"
$rbS = Post "$BASE/projections/rebuild" '{}'
Check 'Rebuild returns 202' ($rbS -eq 202)
Start-Sleep -Seconds 5
$accRb = Invoke-RestMethod -Uri "$BASE/accounts/qa-pg" -UseBasicParsing
Check 'Rebuild restores projection (balance=120)' ($accRb.balance -eq 120)

Write-Host "--- Req17: Snapshotting ---"
$bodySn = '{"accountId":"qa-snap","ownerName":"Eve","initialBalance":0,"currency":"USD"}'
Post "$BASE/accounts" $bodySn | Out-Null
for ($i=1; $i -le 50; $i++) {
    $sd = '{"amount":1,"description":"s","transactionId":"sn-' + $i + '"}'
    Post "$BASE/accounts/qa-snap/deposit" $sd | Out-Null
}
$snapAcc = Invoke-RestMethod -Uri "$BASE/accounts/qa-snap" -UseBasicParsing
Check 'Snapshot: balance=50 after 51 events' ($snapAcc.balance -eq 50)

Write-Host ""
Write-Host "======================================"
Write-Host "FINAL: $pass PASSED, $fail FAILED"
Write-Host "======================================"

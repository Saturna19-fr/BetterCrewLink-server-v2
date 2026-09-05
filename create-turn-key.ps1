<#
.SYNOPSIS
Creates a Cloudflare Realtime TURN key and prints the two values to paste into Coolify.

.DESCRIPTION
The API token you pass here is only used to CREATE the key -- it is not the value that
goes into CF_TURN_API_TOKEN. The call returns a separate uid/key pair, and those are what
the server uses. Mixing the two up produces "404 cannot find specified key" at runtime.

The token needs the "Calls Write" permission.

.EXAMPLE
.\create-turn-key.ps1
.EXAMPLE
.\create-turn-key.ps1 -AccountId abc123... -ApiToken def456...
#>
param(
    [string]$AccountId,
    [string]$ApiToken,
    [string]$Name = 'bettercrewlink'
)

# Windows PowerShell 5.1 can still default to TLS 1.0, which Cloudflare refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $AccountId) { $AccountId = Read-Host 'Cloudflare Account ID (from the dashboard URL)' }
if (-not $ApiToken)  { $ApiToken  = Read-Host 'Cloudflare API token (needs Calls Write)' }

$AccountId = $AccountId.Trim()
$ApiToken  = $ApiToken.Trim()

if ([string]::IsNullOrWhiteSpace($AccountId) -or [string]::IsNullOrWhiteSpace($ApiToken)) {
    Write-Host 'Account ID and API token are both required.' -ForegroundColor Red
    exit 1
}

$uri  = "https://api.cloudflare.com/client/v4/accounts/$AccountId/calls/turn_keys"
$body = @{ name = $Name } | ConvertTo-Json -Compress

Write-Host "Creating TURN key '$Name'..." -ForegroundColor Cyan

try {
    $resp = Invoke-RestMethod -Uri $uri -Method Post `
        -Headers @{ Authorization = "Bearer $ApiToken" } `
        -ContentType 'application/json' -Body $body -ErrorAction Stop
} catch {
    Write-Host ''
    Write-Host 'Request failed.' -ForegroundColor Red

    # PS7 exposes the body on ErrorDetails; 5.1 needs the raw response stream.
    $detail = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $detail = $_.ErrorDetails.Message
    } elseif ($_.Exception.Response) {
        try {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $detail = $reader.ReadToEnd()
        } catch {}
    }

    if ($detail) { Write-Host $detail -ForegroundColor DarkYellow }
    else { Write-Host $_.Exception.Message -ForegroundColor DarkYellow }

    Write-Host ''
    Write-Host 'Most likely causes:' -ForegroundColor Yellow
    Write-Host '  403 / authentication  -> the token is missing the "Calls Write" permission'
    Write-Host '  404                   -> the Account ID is wrong'
    exit 1
}

if (-not $resp.success) {
    Write-Host 'Cloudflare returned success=false:' -ForegroundColor Red
    $resp | ConvertTo-Json -Depth 5
    exit 1
}

$uid = $resp.result.uid
$key = $resp.result.key

Write-Host ''
Write-Host 'Done. Paste these into Coolify:' -ForegroundColor Green
Write-Host ''
Write-Host "CF_TURN_KEY_ID=$uid"
Write-Host "CF_TURN_API_TOKEN=$key"
Write-Host ''

# Sanity check: catching the swap here is cheaper than debugging a 404 after deploy.
if ($uid -notmatch '^[0-9a-f]{32}$') {
    Write-Host "Warning: uid is not the expected 32 hex characters (got $($uid.Length))." -ForegroundColor Yellow
}
if ($key -notmatch '^[0-9a-f]{64}$') {
    Write-Host "Warning: key is not the expected 64 hex characters (got $($key.Length))." -ForegroundColor Yellow
}

Write-Host 'The key above is shown only once - save it now.' -ForegroundColor Yellow
Write-Host 'After redeploying, /health should show turn.valid = true and iceServerCount = 3.'

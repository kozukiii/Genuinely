param(
    [Parameter(Mandatory = $true)]
    [string]$query
)

# Load .env and extract token
$envFile = Get-Content ".env"
foreach ($line in $envFile) {
    if ($line -match "^EBAY_PROD_TOKEN=") {
        $token = ($line -split "=", 2)[1].Trim('"')
    }
}

if (-not $token) {
    Write-Host "ERROR: Could not find EBAY_PROD_TOKEN in .env"
    exit
}

# Encode the query for URL
Add-Type -AssemblyName System.Web
$encodedQuery = [System.Web.HttpUtility]::UrlEncode($query)

# Fetch listings from eBay
$response = Invoke-RestMethod -Uri "https://api.ebay.com/buy/browse/v1/item_summary/search?q=$encodedQuery&limit=5" `
    -Headers @{
        "Authorization" = "Bearer $token"
        "Content-Type"  = "application/json"
    }

# Display results nicely
$response.itemSummaries | ForEach-Object {
    Write-Host ""
    Write-Host "Title   : $($_.title)"
    Write-Host "Price   : $($_.price.value) $($_.price.currency)"
    Write-Host "Link    : $($_.itemWebUrl)"
    Write-Host ""
}

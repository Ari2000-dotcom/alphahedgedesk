# Builds the copy-to-VPS folder ..\..\MarketHub-VPS (and a .zip of it) from this project.
# Run on the PC after `cargo build --release --no-default-features` and copying
# target\release\hub.exe to hub\MarketHub-server.exe.
# No secrets go in it: no .env (broker logins) and no users.toml (API keys), so
# the folder and zip are safe to upload or share. Put those two on the VPS
# yourself, once (e.g. copy them over Remote Desktop); a new package unpacked
# over the folder there leaves them in place. A first install with no .env
# starts a blank one from .env.example.

$ErrorActionPreference = 'Stop'
$hub = Split-Path -Parent $PSScriptRoot
$proj = Split-Path -Parent $hub
$out = Join-Path $proj 'MarketHub-VPS'

# The DuckDNS name from the last package, kept: unpacked over the VPS folder,
# a blank domain.txt would leave the website on its old Caddy settings.
$domain = $null
if (Test-Path "$out\domain.txt") {
    $domain = Get-Content "$out\domain.txt" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') } | Select-Object -First 1
}
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force "$out\hub" | Out-Null

Copy-Item "$proj\.env.example", "$proj\shoonya_auto_login.py" $out
Copy-Item "$PSScriptRoot\windows\*" $out
Copy-Item "$PSScriptRoot\setup-linux.sh" $out
Copy-Item "$hub\MarketHub-server.exe" "$out\hub\MarketHub-server.exe"
Copy-Item "$hub\config.toml", "$hub\Cargo.toml", "$hub\Cargo.lock" "$out\hub"
Copy-Item "$hub\src" "$out\hub\src" -Recurse
Copy-Item $PSScriptRoot "$out\hub\deploy" -Recurse

# The web app (build it first: cd web; npm run build), served by Caddy from web\.
$dist = Join-Path $proj 'web\dist'
if (Test-Path "$dist\index.html") {
    Copy-Item $dist "$out\web" -Recurse
} else {
    Write-Warning "web\dist is missing: run 'npm run build' in the web folder first"
}
Set-Content -Path "$out\domain.txt" -Encoding ASCII -Value (@(
    '# Your DuckDNS name, on the line below without the #, e.g.:',
    '# markethub.duckdns.org',
    '# Then run MarketHub Server.bat again: it sets up the website with HTTPS.'
) + @($domain | Where-Object { $_ }))

# Linux needs LF line endings in the shell script; Windows batch files want CRLF.
$sh = "$out\setup-linux.sh"
[IO.File]::WriteAllText($sh, ([IO.File]::ReadAllText($sh) -replace "`r`n", "`n"))
foreach ($b in Get-ChildItem $out -File | Where-Object { $_.Extension -in '.bat', '.cmd' }) {
    [IO.File]::WriteAllText($b.FullName, ([IO.File]::ReadAllText($b.FullName) -replace "`r?`n", "`r`n"))
}

# Last check before zipping: nothing secret in what may be uploaded or shared.
$secrets = '.env', 'users.toml', 'credentials.bin', 'nubra-device-login.bin'
$found = Get-ChildItem $out -Recurse -File -Force | Where-Object { $_.Name -in $secrets }
if ($found) { throw "secrets in the package, not zipping: $($found.FullName -join ', ')" }

$zip = "$out.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$out\*" -DestinationPath $zip
Write-Host "Package ready: $out"
Write-Host "Zip:           $zip"

# Everything for MarketHub on a Windows VPS, started by "MarketHub Server.bat":
#   1. installs Python, Chrome and the login script's packages (first run only)
#   2. installs/updates MarketHub and keeps it running with Windows (restarts on crash)
#   3. does Nubra's one-time OTP login, only when Nubra needs it
#   4. shows the live status
# MarketHub runs from hub\bin\, a copy of hub\MarketHub-server.exe, so a new version
# can be pasted over hub\MarketHub-server.exe while the old one is running.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$tmp = Join-Path $env:TEMP 'markethub-setup'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    OK   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    WARN $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "    FAIL $t" -ForegroundColor Red; exit 1 }

$newExe = Join-Path $root 'hub\MarketHub-server.exe'
$binDir = Join-Path $root 'hub\bin'
$runExe = Join-Path $binDir 'MarketHub-server.exe'
$log = Join-Path $root 'markethub.log'
$bind = (Select-String -Path (Join-Path $root 'hub\config.toml') -Pattern '^\s*bind\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
$api = 'http://127.0.0.1:' + $bind.Split(':')[-1]

foreach ($f in 'shoonya_auto_login.py', 'run-markethub.cmd', 'hub\MarketHub-server.exe', 'hub\config.toml') {
    if (-not (Test-Path $f)) { Fail "$f is missing next to this script" }
}
# Broker logins live only on this VPS, never in the package (a new package
# unpacked over this folder leaves .env alone). First install: a blank one to fill in.
if (-not (Test-Path '.env')) {
    if (-not (Test-Path '.env.example')) { Fail '.env is missing next to this script: copy yours here' }
    Copy-Item '.env.example' '.env'
    Start-Process notepad.exe -ArgumentList "`"$(Join-Path $root '.env')`""
    Fail '.env made from .env.example and opened in Notepad: fill in your broker logins, save, then run MarketHub Server.bat again'
}

# ---------- 1. tools (each is skipped when already there) ----------
$py = 'C:\Program Files\Python312\python.exe'
if (-not (Test-Path $py)) {
    Step 'Installing Python 3.12'
    $inst = Join-Path $tmp 'python.exe'
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe' -OutFile $inst -UseBasicParsing
    Start-Process $inst -ArgumentList '/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_test=0' -Wait
    if (-not (Test-Path $py)) { Fail 'Python did not install' }
    Ok $py
}
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) {
    Step 'Installing Google Chrome (used only for the daily Shoonya login)'
    $msi = Join-Path $tmp 'chrome.msi'
    Invoke-WebRequest 'https://dl.google.com/chrome/install/googlechromestandaloneenterprise64.msi' -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait
    if (-not (Test-Path $chrome)) { Fail 'Chrome did not install' }
    Ok $chrome
}
$venvPy = Join-Path $root '.venv\Scripts\python.exe'
$pkgMarker = Join-Path $root '.venv\markethub-packages'
if (-not (Test-Path $pkgMarker)) {
    Step 'Installing the login script packages'
    $ErrorActionPreference = 'Continue'  # pip/venv print progress on stderr
    if (-not (Test-Path $venvPy)) { & $py -m venv .venv 2>&1 | Out-Null }
    & $venvPy -m pip install --quiet --disable-pip-version-check selenium pyotp requests python-dotenv 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { Fail 'pip install failed' }
    Set-Content $pkgMarker 'ok'
    Ok 'selenium, pyotp, requests, python-dotenv'
}

# ---------- 2. MarketHub: install / update / keep running ----------
$task = Get-ScheduledTask -TaskName 'MarketHub' -ErrorAction SilentlyContinue
$needCopy = -not (Test-Path $runExe) -or ((Get-FileHash $newExe).Hash -ne (Get-FileHash $runExe).Hash)
if ($needCopy -or -not $task) {
    Step $(if ($task) { 'Updating MarketHub' } else { 'Installing MarketHub' })
    if ($task) { Stop-ScheduledTask -TaskName 'MarketHub' }
    Get-Process 'MarketHub-server' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    New-Item -ItemType Directory -Force $binDir | Out-Null
    Copy-Item $newExe $runExe -Force
    $action = New-ScheduledTaskAction -Execute (Join-Path $root 'run-markethub.cmd') -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName 'MarketHub' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Ok 'MarketHub starts with Windows and restarts if it ever crashes'
}
if ((Get-ScheduledTask -TaskName 'MarketHub').State -ne 'Running') {
    Start-ScheduledTask -TaskName 'MarketHub'
}

# Wait for its API to answer.
$up = $false
foreach ($i in 1..40) {
    try { Invoke-RestMethod "$api/health" -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $up) { Fail "MarketHub did not start; see $log" }
Ok "MarketHub is running ($api)"

# ---------- 2b. Website + HTTPS (Caddy), once domain.txt names the DuckDNS address ----------
# Caddy serves the web app from web\ and passes /ws, /auth, /history, /straddle_history and /health
# to MarketHub; it gets and renews the HTTPS certificate by itself. MarketHub
# itself stays on 127.0.0.1, reachable only through Caddy.
$domainFile = Join-Path $root 'domain.txt'
$web = Join-Path $root 'web'
$domain = $null
if (Test-Path $domainFile) {
    $domain = Get-Content $domainFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') } | Select-Object -First 1
}
if (-not $domain) {
    Warn 'No website yet: put your DuckDNS name (e.g. markethub.duckdns.org) in domain.txt next to this file, then run this again.'
} elseif (-not (Test-Path (Join-Path $web 'index.html'))) {
    Warn 'web\index.html is missing next to this file: copy the web folder from the package.'
} else {
    $caddyDir = Join-Path $root 'caddy'
    $caddy = Join-Path $caddyDir 'caddy.exe'
    if (-not (Test-Path $caddy)) {
        Step 'Installing Caddy (HTTPS web server)'
        New-Item -ItemType Directory -Force $caddyDir | Out-Null
        $zip = Join-Path $tmp 'caddy.zip'
        Invoke-WebRequest 'https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_windows_amd64.zip' -OutFile $zip -UseBasicParsing
        Expand-Archive $zip -DestinationPath $caddyDir -Force
        if (-not (Test-Path $caddy)) { Fail 'Caddy did not install' }
        Ok $caddy
    }
    $hubPort = $bind.Split(':')[-1]
    $webPath = $web.Replace('\', '/')
    $conf = @"
$domain {
	encode zstd gzip
	@hub path /ws /history /straddle_history /health /auth
	handle @hub {
		reverse_proxy 127.0.0.1:$hubPort
	}
	handle {
		root * "$webPath"
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		try_files {path} /index.html
		file_server
	}
}
"@
    $caddyfile = Join-Path $caddyDir 'Caddyfile'
    $changed = -not (Test-Path $caddyfile) -or ((Get-Content $caddyfile -Raw).Trim() -ne $conf.Trim())
    if ($changed) { [IO.File]::WriteAllText($caddyfile, $conf) }

    if (-not (Get-NetFirewallRule -DisplayName 'MarketHub web' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName 'MarketHub web' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null
        Ok 'Windows Firewall: ports 80 and 443 open (open them in your VPS provider''s firewall too)'
    }
    $webTask = Get-ScheduledTask -TaskName 'MarketHub Web' -ErrorAction SilentlyContinue
    if (-not $webTask) {
        Step 'Starting the website with Windows'
        $action = New-ScheduledTaskAction -Execute $caddy -Argument "run --config `"$caddyfile`"" -WorkingDirectory $caddyDir
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName 'MarketHub Web' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    } elseif ($changed) {
        Stop-ScheduledTask -TaskName 'MarketHub Web'
        Start-Sleep -Seconds 1
    }
    if ((Get-ScheduledTask -TaskName 'MarketHub Web').State -ne 'Running') { Start-ScheduledTask -TaskName 'MarketHub Web' }

    # The first start gets the certificate (10-60 s); then the site answers over HTTPS.
    $reachable = $false
    foreach ($i in 1..30) {
        try { Invoke-WebRequest "https://$domain/health" -UseBasicParsing -TimeoutSec 5 | Out-Null; $reachable = $true; break } catch { Start-Sleep -Seconds 3 }
    }
    if ($reachable) {
        Ok "Website: https://$domain"
    } else {
        Warn "https://$domain does not answer yet. Check: DuckDNS points at this VPS's IP, and ports 80 and 443 are open in the VPS provider's firewall."
    }
}

# ---------- 3. Nubra one-time OTP, only when needed ----------
function Call($method, $path, $body) {
    $req = @{ Method = $method; Uri = "$api$path"; ContentType = 'application/json'; TimeoutSec = 60 }
    if ($body) { $req.Body = ($body | ConvertTo-Json -Compress) }
    try {
        # Windows PowerShell reads the UTF-8 reply as Latin-1 (garbling the •••• in phone
        # numbers); take the raw bytes and decode them as UTF-8.
        $raw = Invoke-WebRequest @req -UseBasicParsing
        $text = [Text.Encoding]::UTF8.GetString($raw.RawContentStream.ToArray())
        return @{ ok = $true; msg = ($text | ConvertFrom-Json).message }
    } catch {
        $msg = $_.Exception.Message
        if ($_.ErrorDetails.Message) {
            # Same Latin-1 mix-up as above: turn the text back into bytes and read them as UTF-8.
            $body = [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding(28591).GetBytes($_.ErrorDetails.Message))
            try { $msg = ($body | ConvertFrom-Json).error } catch { $msg = $body }
        }
        return @{ ok = $false; msg = $msg }
    }
}
function Ask-Secret($prompt) {
    $s = Read-Host $prompt -AsSecureString
    [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

$st = Call 'GET' '/admin/nubra/status'
if ($st.ok -and $st.msg -match 'enter mobile|one-time OTP|new OTP') {
    Step "Nubra needs a one-time OTP login (now: $($st.msg))"
    Write-Host '    After this, Nubra logs in by itself every day with the MPIN.'
    $askAll = $st.msg -match 'enter mobile'
    for ($try = 1; $try -le 3; $try++) {
        $fields = @{}
        $phone = Read-Host ('    Nubra mobile number' + $(if ($askAll) { '' } else { ' (Enter = keep saved)' }))
        if ($phone.Trim()) { $fields.NUBRA_PHONE = $phone.Trim() }
        $pin = Ask-Secret ('    Nubra MPIN' + $(if ($askAll) { '' } else { ' (Enter = keep saved)' }))
        if ($pin.Trim()) { $fields.NUBRA_MPIN = $pin.Trim() }
        if ($fields.Count) {
            $r = Call 'POST' '/admin/creds' $fields
            if (-not $r.ok) { Warn $r.msg; continue }
        }
        $r = Call 'POST' '/admin/nubra/send-otp'
        if (-not $r.ok) { Warn $r.msg; $askAll = $true; continue }
        Ok $r.msg
        $otp = Read-Host '    OTP from the SMS'
        $r = Call 'POST' '/admin/nubra/verify' @{ otp = $otp.Trim() }
        if ($r.ok) { Ok $r.msg; break }
        Warn $r.msg
        if ($try -lt 3) { Write-Host '    Trying again...' }
    }
}

# ---------- 4. live status ----------
Step 'Live status (green = up, amber = waiting, red = down). Close this window any time; MarketHub keeps running.'
Get-Content -Path $log -Encoding UTF8 -Tail 15 -Wait

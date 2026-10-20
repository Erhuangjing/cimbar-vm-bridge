# 极简静态文件服务器（Win11 宿主机上运行，无需安装 Python/Node）
# 作用：让 Win7 虚拟机通过 http://宿主机IP:端口/cimbar-send.html 打开发送端；
#       宿主机自己通过 http://localhost:端口/cimbar-recv.html 打开接收端（localhost 属于安全上下文）。
# 用法：双击同目录下的「启动服务器.bat」，或 powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8000]
param([int]$Port = 8000)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootPrefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.wasm' = 'application/wasm'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.json' = 'application/json'
  '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
try {
  $listener.Start()
} catch {
  Write-Host "端口 $Port 被占用，请换一个：powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8080" -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

Write-Host ''
Write-Host '==== Cimbar 本地服务器已启动 ====' -ForegroundColor Green
Write-Host "宿主机（Win11）接收端： http://localhost:$Port/cimbar-recv.html" -ForegroundColor Cyan
Write-Host '虚拟机（Win7）发送端，按虚拟机网络模式选择一个能访问到的地址：' -ForegroundColor Cyan
try {
  foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne 'Up') { continue }
    foreach ($ua in $nic.GetIPProperties().UnicastAddresses) {
      $ip = $ua.Address.ToString()
      if ($ua.Address.AddressFamily -ne 'InterNetwork' -or $ip -eq '127.0.0.1' -or $ip -like '169.254.*') { continue }
      Write-Host ("   http://{0}:{1}/cimbar-send.html    ({2})" -f $ip, $Port, $nic.Name)
    }
  }
} catch {
  Write-Host '   （无法列出本机 IP，请在命令行运行 ipconfig 查看）'
}
Write-Host '提示：VirtualBox NAT 模式下虚拟机可用 http://10.0.2.2:端口/ 访问宿主机。'
Write-Host '若虚拟机打不开，请在 Windows 防火墙弹窗中允许“专用网络”访问，或临时放行该端口。'
Write-Host '关闭此窗口即可停止服务器。'
Write-Host ''

function Send-Response($stream, [int]$code, [string]$status, [string]$ctype, [byte[]]$body, [bool]$headOnly) {
  $hdr = "HTTP/1.1 $code $status`r`nContent-Type: $ctype`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $h = [System.Text.Encoding]::ASCII.GetBytes($hdr)
  $stream.Write($h, 0, $h.Length)
  if (-not $headOnly -and $body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 2000
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
      $line = $reader.ReadLine()
      while ($true) { $l = $reader.ReadLine(); if ($l -eq $null -or $l -eq '') { break } }
      if (-not $line) { continue }
      $parts = $line.Split(' ')
      $method = $parts[0]
      $rawPath = ($parts[1] -split '\?')[0]
      $rel = [System.Uri]::UnescapeDataString($rawPath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      $remote = $client.Client.RemoteEndPoint
      if ($method -ne 'GET' -and $method -ne 'HEAD') {
        Send-Response $stream 405 'Method Not Allowed' 'text/plain' ([byte[]]@()) $false
      }
      elseif (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('404 Not Found')) ($method -eq 'HEAD')
        Write-Host "$remote  404 /$rel"
      }
      else {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ctype = $types[$ext]; if (-not $ctype) { $ctype = 'application/octet-stream' }
        Send-Response $stream 200 'OK' $ctype ([System.IO.File]::ReadAllBytes($full)) ($method -eq 'HEAD')
        Write-Host "$remote  200 /$rel"
      }
    } catch {
      Write-Host "请求处理出错：$($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}

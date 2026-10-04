# StudyDrive Local Server (No Python/Node needed!)
# Run this script, then open http://localhost:8080

$port = 8080
$root = $PSScriptRoot

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host ""
Write-Host "  =======================================" -ForegroundColor Cyan
Write-Host "   StudyDrive is running!" -ForegroundColor Green
Write-Host "  =======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Open this in your browser:" -ForegroundColor White
Write-Host "  --> http://localhost:$port" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Press Ctrl+C to stop the server." -ForegroundColor Gray
Write-Host ""

# Automatically open browser
Start-Process "http://localhost:$port"

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
    ".woff2"= "font/woff2"
    ".woff" = "font/woff"
}

while ($listener.IsListening) {
    try {
        $context  = $listener.GetContext()
        $request  = $context.Request
        $response = $context.Response

        $urlPath = $request.Url.AbsolutePath
        if ($urlPath -eq "/") { $urlPath = "/index.html" }

        $filePath = Join-Path $root $urlPath.TrimStart("/")

        if (Test-Path $filePath -PathType Leaf) {
            $ext      = [System.IO.Path]::GetExtension($filePath).ToLower()
            $mimeType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
            $bytes    = [System.IO.File]::ReadAllBytes($filePath)

            $response.ContentType   = $mimeType
            $response.ContentLength64 = $bytes.Length
            $response.StatusCode    = 200
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }

        $response.OutputStream.Close()
    } catch {
        # Ignore errors from cancelled requests
    }
}

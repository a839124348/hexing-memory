$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ready = Join-Path $here '.ready'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js not found. DSH itself needs Node, so install Node first.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm not found. Install Node.js with npm first.'
}
if (-not (Test-Path (Join-Path $here 'model.onnx'))) {
  throw 'model.onnx missing. Use the release package with the ONNX model files.'
}

Write-Host "[onnx] Installing runtime into $here"
Push-Location $here
try {
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally {
  Pop-Location
}

Set-Content -Path $ready -Value (Get-Date).ToString('o') -Encoding ASCII
Write-Host "[onnx] Ready: $ready"
Write-Host "[onnx] Restart DSH. The plugin will auto-start ONNX when port 16891 is free."

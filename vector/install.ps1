$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$req = Join-Path $here 'requirements.txt'
$server = Join-Path $here 'embed_server.py'
$ready = Join-Path $here '.ready'

$python = $env:PYTHON
if (-not $python) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $python = $cmd.Source }
}
if (-not $python) {
  $cmd = Get-Command py -ErrorAction SilentlyContinue
  if ($cmd) { $python = $cmd.Source; $launcher = @('-3') }
}
if (-not $python) {
  throw 'Python 3 not found. Install Python and add it to PATH, or set $env:PYTHON.'
}

Write-Host "[vector] Python: $python"
if ($launcher) {
  & $python @launcher -m pip install -r $req
} else {
  & $python -m pip install -r $req
}
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

if ($env:BGE_MODEL_PATH) {
  $model = $env:BGE_MODEL_PATH
} else {
  $model = 'BAAI/bge-small-zh-v1.5'
}
Write-Host "[vector] Preparing model: $model (first run needs network)"
$pyCode = "from sentence_transformers import SentenceTransformer; SentenceTransformer(r'$model'); print('model ready')"
if ($launcher) {
  & $python @launcher -c $pyCode
} else {
  & $python -c $pyCode
}
if ($LASTEXITCODE -ne 0) { throw 'model load failed' }

Set-Content -Path $ready -Value (Get-Date).ToString('o') -Encoding ASCII
Write-Host "[vector] Ready: $ready"
Write-Host "[vector] Restart DSH. The plugin will auto-start this service when port 16891 is free."

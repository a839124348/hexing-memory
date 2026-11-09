#requires -Version 5.1
<#
.SYNOPSIS
  核星记忆 / Hexing Memory — DSH 安装器（DryRun 默认）

.DESCRIPTION
  给 DSH 模型用：检查仓库结构 / Node / DSH / profile，备份后把插件本体或侧边栏入口
  幂等插入 cordis.patch.yml，检查模型与 ONNX 依赖，跑路径自检。
  默认只打印计划；加 -Apply 才写入。
  -Phase core（默认）只装插件本体；-Phase ui 只装左侧栏「记忆总览」，且要求已选迁移模式；
  -Phase all 两段都装（已完成 onboarding 的重装场景）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase core -DryRun
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase core -Apply
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase ui -Apply
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Phase all -Apply -DownloadModels
#>
param(
  [string]$InstallDir = "",
  [string]$ProfilePath = "",
  [ValidateSet('core', 'ui', 'all')]
  [string]$Phase = 'core',
  [switch]$Apply,
  [switch]$DryRun,
  [switch]$DownloadModels,
  [switch]$SkipDeps,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$script:Failed = $false

function Info([string]$msg) { Write-Host $msg }
function Good([string]$msg) { Write-Host $msg -ForegroundColor Green }
function Warn([string]$msg) { Write-Host ('WARN  ' + $msg) -ForegroundColor Yellow }
function Bad([string]$msg) { Write-Host ('ERROR ' + $msg) -ForegroundColor Red; $script:Failed = $true }
function Sha256([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToUpperInvariant()
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $InstallDir) { $InstallDir = $Root }
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
$doApply = ($Apply -and -not $DryRun)

Info '=== 核星记忆 · 安装检查 ==='
Info ('安装目录：' + $InstallDir)
Info ('阶段：' + $Phase + '（core=只装插件本体；ui=只装侧边栏入口；all=两者）')
Info ('模式：' + $(if ($doApply) { 'APPLY（会写 profile）' } else { 'DRY-RUN（不写任何文件）' }))
Info ''

# ── 1. 仓库结构 ─────────────────────────────────────
$required = @(
  'dsh-plugin\src\index.ts',
  'dsh-plugin\package.json',
  'src\store.js',
  'docs\RULES.md',
  'tools\check-paths.js'
)
foreach ($rel in $required) {
  $p = Join-Path $InstallDir $rel
  if (Test-Path -LiteralPath $p) { Good ('OK   ' + $rel) }
  else { Bad ('缺少 ' + $rel + '；请确认解压的是完整仓库根目录，不是 release 暂存或 dsh-plugin 子目录') }
}
if ($script:Failed) { exit 1 }

# ── 2. Node / DSH ──────────────────────────────────
$nodeVersion = $null
try { $nodeVersion = (& node -v 2>$null) } catch { }
if (-not $nodeVersion) {
  Bad '找不到 node。先安装 Node.js >= 20。'
} else {
  $major = 0
  [void][int]::TryParse(($nodeVersion.TrimStart('v').Split('.')[0]), [ref]$major)
  if ($major -lt 20) { Bad ('Node 版本过低：' + $nodeVersion + '；需要 >= 20') }
  else { Good ('OK   Node ' + $nodeVersion) }
}

$dshVersion = $null
try { $dshVersion = (& dsh --version 2>$null) } catch { }
if (-not $dshVersion) { Warn '找不到 dsh 命令；如果你用的是 DSH Desktop，可忽略，只要 profile 存在。' }
else { Good ('OK   DSH ' + ($dshVersion -join ' ')) }

# ── 3. profile ─────────────────────────────────────
if (-not $ProfilePath) {
  $ProfilePath = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
}
if (-not (Test-Path -LiteralPath $ProfilePath)) {
  Bad ('profile 不存在：' + $ProfilePath)
  Info '先运行一次 `dsh web` 初始化 web profile，再回来安装；或确认 DSH 装在别的用户目录。'
  exit 1
}
$ProfilePath = (Resolve-Path -LiteralPath $ProfilePath).Path
Good ('OK   profile ' + $ProfilePath)

$entry = (Join-Path $InstallDir 'dsh-plugin\src\index.ts').Replace('\', '/')
$entryUi = (Join-Path $InstallDir 'dsh-plugin-ui\lib\index.js').Replace('\', '/')
$entryYaml = $entry.Replace("'", "''")
$entryUiYaml = $entryUi.Replace("'", "''")
$nl = [Environment]::NewLine

$profileText = [System.IO.File]::ReadAllText($ProfilePath)
$hasMemory = [regex]::IsMatch($profileText, '(?m)^\s*-\s*id:\s*memory-system\s*$')
$hasUi = [regex]::IsMatch($profileText, '(?m)^\s*-\s*id:\s*memory-system-ui\s*$')
$pointsToUs = $profileText.Contains($entry)
$pointsToUsUi = $profileText.Contains($entryUi)
$uiExists = Test-Path -LiteralPath (Join-Path $InstallDir 'dsh-plugin-ui\lib\client.js')

$wantCore = ($Phase -eq 'core' -or $Phase -eq 'all')
$wantUi = ($Phase -eq 'ui' -or $Phase -eq 'all')

# 侧边栏入口只在“已经选过迁移模式”后才装；否则总览页是一片 0，首体验很差。
if ($wantUi -and -not $Force) {
  $dataRoot = $env:MEMORY_ROOT
  if (-not $dataRoot) { $dataRoot = Join-Path $env:APPDATA 'dsh-memory' }
  $onboardingFile = Join-Path $dataRoot 'common\onboarding.json'
  $mode = $null
  try { if (Test-Path -LiteralPath $onboardingFile) { $mode = (Get-Content -LiteralPath $onboardingFile -Raw | ConvertFrom-Json).mode } } catch { }
  if (-not $mode) {
    Warn '还没选迁移模式，暂不安装侧边栏入口。先让模型跑 memory_onboarding action=save（inherit/memory/fresh），再回来 -Phase ui -Apply。'
    Warn '如果确认要强行安装，加 -Force。'
    $wantUi = $false
  }
}

$lines = @()
if ($wantCore -and -not $hasMemory) {
  $lines += '    - id: memory-system'
  $lines += "      name: '$entryYaml'"
} elseif ($wantCore -and -not $pointsToUs) {
  Warn 'profile 已经有 memory-system，但似乎指向别的路径。为避免破坏，脚本不自动改；请人工确认后调整。'
}
if ($wantUi) {
  if (-not $uiExists) {
    Bad '缺少 dsh-plugin-ui：侧边栏入口无法安装。请确认解压的是完整仓库。'
  } elseif (-not $hasUi) {
    $lines += '    - id: memory-system-ui'
    $lines += "      name: '$entryUiYaml'"
  } elseif (-not $pointsToUsUi) {
    Warn 'profile 已经有 memory-system-ui，但似乎指向别的路径。为避免破坏，脚本不自动改；请人工确认后调整。'
  }
}

$block = ''
if ($lines.Count -gt 0) { $block = ($nl + '- insert:' + $nl) + ($lines -join $nl) + $nl }

Info ''
Info '将插入的 YAML：'
if ($block) { Write-Host $block -ForegroundColor Cyan } else { Good 'OK   profile 已满足当前阶段，无需写入。' }

if ($block -and $doApply) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = $ProfilePath + '.bak-' + $stamp
  Copy-Item -LiteralPath $ProfilePath -Destination $backup -Force
  Good ('备份：' + $backup)
  $prefix = ''
  if ($profileText.Length -gt 0 -and -not $profileText.EndsWith("`n") -and -not $profileText.EndsWith("`r")) {
    $prefix = $nl
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::AppendAllText($ProfilePath, $prefix + $block, $utf8)
  Good '已写入 profile。'
} elseif ($block -and -not $doApply) {
  Info 'DRY-RUN：未写入 profile。确认后加 -Apply。'
}

# ── 4. 模型文件 ────────────────────────────────────
$onnxDir = Join-Path $InstallDir 'vector\onnx'
$modelPath = Join-Path $onnxDir 'model.onnx'
$dataPath = Join-Path $onnxDir 'bge-small-zh-v1.5.onnx.data'
$readyPath = Join-Path $onnxDir '.ready'
$expectedModel = 'E96E1CA1523D61CD0DBBA45B40A4E8B7D7CBED58FC51C0370BC8827C43FD785B'
$expectedData = '02A5F74BE93B625908C7AE11B04042C21F06864E9A439605D304367388F2B256'
$modelReady = $false

$pkgPath = Join-Path $InstallDir 'dsh-plugin\package.json'
$version = '0.4.2'
try { $version = (Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).version } catch { }
$tag = 'v' + $version

if ((Test-Path -LiteralPath $modelPath) -and (Test-Path -LiteralPath $dataPath)) {
  $mHash = Sha256 $modelPath
  $dHash = Sha256 $dataPath
  if ($mHash -eq $expectedModel -and $dHash -eq $expectedData) {
    $modelReady = $true
    Good 'OK   向量模型文件与 SHA256 校验通过。'
  } else {
    Bad '向量模型 SHA256 不一致；文件可能损坏。删除后重新下载，不要带病安装。'
    Info ('model.onnx = ' + $mHash)
    Info ('.data      = ' + $dHash)
  }
} elseif ($DownloadModels) {
  if (-not $doApply) {
    Info 'DRY-RUN：将下载缺失的模型文件（本次不写）。'
  } else {
    Info ('下载模型到 ' + $onnxDir + ' ...')
    New-Item -ItemType Directory -Force -Path $onnxDir | Out-Null
    $base = 'https://github.com/a839124348/hexing-memory/releases/download/' + $tag
    try {
      if (-not (Test-Path -LiteralPath $modelPath)) {
        Invoke-WebRequest -UseBasicParsing -Uri ($base + '/model.onnx') -OutFile $modelPath
      }
      if (-not (Test-Path -LiteralPath $dataPath)) {
        Invoke-WebRequest -UseBasicParsing -Uri ($base + '/bge-small-zh-v1.5.onnx.data') -OutFile $dataPath
      }
      $mHash = Sha256 $modelPath
      $dHash = Sha256 $dataPath
      if ($mHash -eq $expectedModel -and $dHash -eq $expectedData) {
        $modelReady = $true
        Good 'OK   模型下载并校验通过。'
      } else {
        Bad '模型下载后 SHA256 不一致；删除后重试。'
      }
    } catch {
      Bad ('模型下载失败：' + $_.Exception.Message)
      Info '可以让用户改用 full zip（已含模型），或开代理后重试。'
    }
  }
} else {
  Warn '缺少向量模型文件。插件仍可启动，但语义召回会降级关键词。'
  Info ('缺：' + $modelPath)
  Info ('缺：' + $dataPath)
  Info '补法：重新运行并加 -DownloadModels，或使用 full zip。'
}

# ── 5. ONNX 依赖（可选）────────────────────────────
if (-not $SkipDeps) {
  $onnxPkg = Join-Path $onnxDir 'package.json'
  $onnxModules = Join-Path $onnxDir 'node_modules'
  $depsReady = Test-Path -LiteralPath $onnxModules
  if ((Test-Path -LiteralPath $onnxPkg) -and -not $depsReady) {
    if (-not $doApply) {
      Info 'DRY-RUN：将安装 ONNX 依赖（npm install）并生成 .ready（本次不写）。'
    } else {
      Info '安装 ONNX 依赖（npm install）...'
      Push-Location $onnxDir
      try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -eq 0) {
          $depsReady = $true
          Good 'OK   ONNX 依赖已安装。'
        } else {
          Warn ('npm install 返回 ' + $LASTEXITCODE + '；向量服务会降级关键词，不影响启动。')
        }
      } catch {
        Warn ('npm install 失败：' + $_.Exception.Message + '；向量服务会降级关键词。')
      } finally {
        Pop-Location
      }
    }
  } elseif ($depsReady) {
    Good 'OK   ONNX 依赖已存在。'
  }

  # 插件靠 .ready 判断“依赖已装好、可以自动拉起”；缺了它，模型和依赖都在也只会降级关键词。
  if ($depsReady -and $modelReady -and -not (Test-Path -LiteralPath $readyPath)) {
    if (-not $doApply) {
      Info 'DRY-RUN：将生成 vector/onnx/.ready（本次不写）。'
    } else {
      try {
        Set-Content -LiteralPath $readyPath -Value (Get-Date).ToString('o') -Encoding ASCII
        Good 'OK   已生成 vector/onnx/.ready，插件会自动拉起向量服务。'
      } catch {
        Warn ('生成 .ready 失败：' + $_.Exception.Message + '；向量服务不会自动拉起。')
      }
    }
  }
}

# ── 6. 路径自检 ────────────────────────────────────
Info ''
if ($doApply) {
  Info '运行路径自检...'
  try {
    & node (Join-Path $InstallDir 'tools\check-paths.js') --profile $ProfilePath
    if ($LASTEXITCODE -ne 0) { Warn '路径自检有红项；按上面提示修，不要改 DSH 源码。' }
  } catch {
    Warn ('路径自检失败：' + $_.Exception.Message)
  }
} else {
  Info 'DRY-RUN：路径自检会在 -Apply 后运行（需要先写入 profile）。'
}

# ── 7. 下一步 ──────────────────────────────────────
Info ''
if ($doApply) {
  Good '=== 写入完成 ==='
  Info '下一步：'
  Info '1. 重启 DSH（停掉当前 dsh web 后重新启动；桌面版退出重开）'
  Info '2. 打开 http://127.0.0.1:3080，让模型调用 memory_common'
  if ($Phase -eq 'core') {
    Info '3. 让模型读 memory_manual 19 节并 ack'
    Info '4. 让模型跑 memory_onboarding 三选一；要迁移就导入旧对话'
    Info '5. 迁移/初始化完成、总览页有数据后，再运行：install.ps1 -Phase ui -Apply'
    Info '6. 再重启 DSH，左侧栏才会出现「记忆总览」'
  } elseif ($Phase -eq 'ui') {
    Info '3. 左侧栏应出现「记忆总览」，点开直接看 3099'
    Info '4. 如果没出现，检查启动日志和 profile 里的 memory-system-ui'
  } else {
    Info '3. 让模型调用 memory_onboarding action=status（应返回 mode:null）'
    Info '4. 让模型读 memory_manual 19 节并 ack；要迁移旧对话再问三选一'
    Info '5. 左侧栏应出现「记忆总览」'
  }
  Info ('如果 DSH 启动失败：恢复 ' + $ProfilePath + '.bak-<时间>，重启，保留数据目录。')
} else {
  Info '=== DRY-RUN 结束，没有写入任何文件 ==='
  Info '把上面的 YAML 和 profile 路径给用户确认；确认后加 -Apply。'
}

if ($script:Failed) { exit 1 }
exit 0

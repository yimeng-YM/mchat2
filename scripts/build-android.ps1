[CmdletBinding()]
param(
    [ValidateSet('lintDebug', 'testDebugUnitTest', 'compileDebugKotlin', 'assembleDebug')]
    [string]$Task = 'assembleDebug'
)

$ErrorActionPreference = 'Stop'

function Get-JavaMajorVersion {
    param([string]$JavaHomePath)

    $javaExecutable = Join-Path $JavaHomePath 'bin\java.exe'
    $javacExecutable = Join-Path $JavaHomePath 'bin\javac.exe'
    if (-not (Test-Path -LiteralPath $javaExecutable) -or -not (Test-Path -LiteralPath $javacExecutable)) {
        return $null
    }
    $versionText = (& cmd.exe /d /c "`"$javaExecutable`" -version 2>&1" | Out-String)
    if ($versionText -notmatch 'version\s+"(?<major>\d+)') {
        return $null
    }
    return [int]$Matches.major
}

$javaCandidates = [System.Collections.Generic.List[string]]::new()
if ($env:JAVA_HOME) {
    $javaCandidates.Add($env:JAVA_HOME)
}
$javaCandidates.Add((Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'))
$javaCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr'))

$javaCommands = & where.exe java.exe 2>$null
foreach ($javaCommand in $javaCommands) {
    $binDirectory = Split-Path -Parent $javaCommand
    if ((Split-Path -Leaf $binDirectory) -eq 'bin') {
        $javaCandidates.Add((Split-Path -Parent $binDirectory))
    }
}

$selectedJavaHome = $null
foreach ($candidate in ($javaCandidates | Select-Object -Unique)) {
    if (-not $candidate) {
        continue
    }
    $major = Get-JavaMajorVersion -JavaHomePath $candidate
    if ($major -ge 17 -and $major -le 21) {
        $selectedJavaHome = $candidate
        break
    }
}

if (-not $selectedJavaHome) {
    throw 'JDK 17-21 was not found. Install JDK 21 or configure JAVA_HOME.'
}

$env:JAVA_HOME = $selectedJavaHome
$env:Path = (Join-Path $selectedJavaHome 'bin') + [System.IO.Path]::PathSeparator + $env:Path
$androidDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\android'))

Write-Host "Using Java: $selectedJavaHome"
Write-Host "Running Gradle task: $Task"

Push-Location $androidDirectory
try {
    & '.\gradlew.bat' --no-daemon $Task
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle task failed with exit code: $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

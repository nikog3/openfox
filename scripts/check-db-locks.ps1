$ErrorActionPreference = 'SilentlyContinue'
$localAppData = $env:LOCALAPPDATA
foreach ($base in @("$localAppData\openfox\sessions.db","$localAppData\openfox-dev\sessions.db")) {
  $name = Split-Path $base -Leaf
  $dir  = Split-Path $base -Parent
  foreach ($suffix in @('','-wal','-shm')) {
    $f = Join-Path $dir ($name+$suffix)
    if (Test-Path $f) {
      try {
        $fs = [System.IO.File]::Open($f,'Open','ReadWrite','None')
        $fs.Close()
        $lock = 'FREE'
      } catch {
        $lock = 'LOCKED'
      }
      $len = (Get-Item $f).Length
      $mtime = (Get-Item $f).LastWriteTime
      Write-Output ("{0,-50} {1,12} bytes  {2,-7} mtime={3}" -f ($name+$suffix), $len, $lock, $mtime.ToString('MM-dd HH:mm'))
    }
  }
}

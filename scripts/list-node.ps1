Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object {
  Write-Output ("PID={0} :: {1}" -f $_.ProcessId, ($_.CommandLine -replace '\s+', ' '))
}

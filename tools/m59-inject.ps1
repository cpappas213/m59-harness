<#
  Inject the m59agent DLL into every running Meridian client.

    powershell -File tools/m59-inject.ps1

  TWO CLIENTS, TWO ARCHITECTURES, TWO DLLS

  The Steam client is a 32-bit process. The patched client that m59-devclient.mjs
  launches is built from the source tree as x64. A DLL loads only into a process of its
  own architecture - LoadLibrary of the wrong one returns NULL with no other symptom -
  so there are two: m59agent.dll (x86) and m59agent64.dll (x64), both built from the
  one m59agent.c beside them. Each client is asked which it is (IsWow64Process) and
  gets the matching one.

  WHY IT RE-LAUNCHES ITSELF

  LoadLibraryA is the remote thread's entry point, and its address has to be the one
  valid IN THE TARGET - kernel32 is loaded at a different base for 32-bit and 64-bit
  processes, so an injector of one architecture resolves an address that means nothing
  in a target of the other and the remote thread dies on arrival. The 64-bit PowerShell
  this starts in therefore handles the 64-bit clients itself, then re-launches as 32-bit
  (SysWOW64 holds that copy; the naming looks backwards and is not) for the rest, because
  WOW64 maps the same kernel32 for every 32-bit process in the session.
#>
param([string]$Dll = '', [string]$Dll64 = '', [string]$ProcName = 'Meridian', [switch]$Only32)

$here = Split-Path $PSCommandPath -Parent
if (-not $Dll)   { $Dll   = Join-Path $here 'm59-agent\m59agent.dll' }
if (-not $Dll64) { $Dll64 = Join-Path $here 'm59-agent\m59agent64.dll' }
$Dll   = (Resolve-Path $Dll   -ErrorAction SilentlyContinue).Path
$Dll64 = (Resolve-Path $Dll64 -ErrorAction SilentlyContinue).Path
if (-not $Dll -and -not $Dll64) { Write-Error 'neither m59agent.dll nor m59agent64.dll found - build one first'; exit 1 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Inj {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr addr, uint size, uint type, uint protect);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, uint size, out IntPtr written);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr CreateRemoteThread(IntPtr h, IntPtr sa, uint stack, IntPtr start, IntPtr param, uint flags, IntPtr tid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandleA(string n);
  [DllImport("kernel32.dll")] public static extern IntPtr GetProcAddress(IntPtr h, string n);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeThread(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsWow64Process(IntPtr h, out bool wow);
}
'@

# 32-bit or not, asked of the process rather than assumed. Works from either bitness of
# PowerShell, which the Modules list does not - a 32-bit process cannot enumerate a 64-bit
# one's modules and throws instead.
function Is32Bit($proc) {
  $h = [Inj]::OpenProcess(0x1000, $false, $proc.Id)   # PROCESS_QUERY_LIMITED_INFORMATION
  if ($h -eq [IntPtr]::Zero) { return $null }
  $wow = $false
  $ok = [Inj]::IsWow64Process($h, [ref]$wow)
  [Inj]::CloseHandle($h) | Out-Null
  if (-not $ok) { return $null }
  return $wow
}

$PROCESS_ALL = 0x1F0FFF
$MEM_COMMIT_RESERVE = 0x3000
$PAGE_RW = 0x04

function Inject-Into($proc, $dllPath) {
  # Skip a client that already carries the agent. LoadLibrary on an already-loaded
  # module only bumps its refcount and never re-runs DllMain, so a second injection
  # would silently do nothing and look like it worked.
  try {
    foreach ($m in $proc.Modules) {
      if ($m.ModuleName -like 'm59agent*.dll') { "pid $($proc.Id): already injected"; return }
    }
  } catch { <# a 32-bit PowerShell cannot list a 64-bit process's modules; that process is not ours to inject #> }
  if (-not $dllPath) { Write-Warning "pid $($proc.Id): no DLL built for its architecture"; return }

  $h = [Inj]::OpenProcess($PROCESS_ALL, $false, $proc.Id)
  if ($h -eq [IntPtr]::Zero) {
    Write-Warning "pid $($proc.Id): OpenProcess failed ($([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message))"
    return
  }

  $bytes = [Text.Encoding]::ASCII.GetBytes($dllPath + [char]0)
  $remote = [Inj]::VirtualAllocEx($h, [IntPtr]::Zero, [uint32]$bytes.Length, $MEM_COMMIT_RESERVE, $PAGE_RW)
  if ($remote -eq [IntPtr]::Zero) { Write-Warning "pid $($proc.Id): VirtualAllocEx failed"; return }

  $written = [IntPtr]::Zero
  if (-not [Inj]::WriteProcessMemory($h, $remote, $bytes, [uint32]$bytes.Length, [ref]$written)) {
    Write-Warning "pid $($proc.Id): WriteProcessMemory failed"; return
  }

  $loadLib = [Inj]::GetProcAddress([Inj]::GetModuleHandleA('kernel32.dll'), 'LoadLibraryA')
  $thread = [Inj]::CreateRemoteThread($h, [IntPtr]::Zero, 0, $loadLib, $remote, 0, [IntPtr]::Zero)
  if ($thread -eq [IntPtr]::Zero) { Write-Warning "pid $($proc.Id): CreateRemoteThread failed"; return }

  [Inj]::WaitForSingleObject($thread, 5000) | Out-Null
  $code = 0
  [Inj]::GetExitCodeThread($thread, [ref]$code) | Out-Null
  [Inj]::CloseHandle($thread) | Out-Null
  [Inj]::CloseHandle($h) | Out-Null

  # LoadLibraryA returns the module handle, so zero means the DLL refused to load.
  if ($code -eq 0) { Write-Warning "pid $($proc.Id): LoadLibraryA returned NULL (wrong architecture?)"; return }
  "pid $($proc.Id): injected, module 0x{0:X}" -f $code
}

# EVERY client, not just the first. Meridian runs several copies happily and each
# needs its own agent; the DLL claims its own port, so nothing here coordinates.
$procs = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
if (-not $procs) { Write-Error "no $ProcName process running"; exit 1 }
$p32 = @(); $p64 = @()
foreach ($proc in $procs) {
  $is32 = Is32Bit $proc
  if ($is32 -eq $null) { Write-Warning "pid $($proc.Id): cannot tell its architecture"; continue }
  if ($is32) { $p32 += $proc } else { $p64 += $proc }
}

if ([IntPtr]::Size -eq 8) {
  # 64-bit stage: our own architecture's clients, then hand the rest to a 32-bit copy.
  foreach ($proc in $p64) { Inject-Into $proc $Dll64 }
  if ($p32) {
    $ps32 = "$env:SystemRoot\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path $ps32)) { Write-Error 'no 32-bit PowerShell available for the 32-bit clients'; exit 1 }
    $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-ProcName', $ProcName, '-Only32')
    if ($Dll) { $fwd += @('-Dll', $Dll) }
    & $ps32 @fwd
    exit $LASTEXITCODE
  }
} else {
  # 32-bit stage: only ever the 32-bit clients. Started directly rather than from the
  # 64-bit stage, any 64-bit client present is somebody else's to inject.
  if ($p64 -and -not $Only32) { Write-Warning "$($p64.Count) 64-bit client(s) need the 64-bit PowerShell; run this from it" }
  foreach ($proc in $p32) { Inject-Into $proc $Dll }
}

# Report who actually came up, by asking. The DLL reports its own port and pid, so
# the sweep is also the discovery mechanism a controller uses.
Start-Sleep -Milliseconds 900
foreach ($port in 8913..8928) {
  try {
    $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port)
    $s = $c.GetStream(); $w = New-Object IO.StreamWriter($s); $r = New-Object IO.StreamReader($s)
    $w.WriteLine('pos'); $w.Flush()
    "  $($r.ReadLine())"
    $c.Close()
  } catch { }
}

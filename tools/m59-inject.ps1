<#
  Inject m59agent.dll into the running Meridian client.

    powershell -File tools/m59-inject.ps1

  WHY IT RE-LAUNCHES ITSELF

  The client is a 32-bit process. LoadLibraryA is the remote thread's entry point, and
  its address has to be the one valid IN THE TARGET - kernel32 is loaded at a different
  base for 32-bit and 64-bit processes, so a 64-bit injector resolves an address that
  means nothing over there and the remote thread dies on arrival. Running the injector
  itself as 32-bit makes GetProcAddress return the right value, because WOW64 maps the
  same kernel32 for every 32-bit process in the session.
#>
param([string]$Dll = '', [string]$ProcName = 'Meridian')

# Re-exec under 32-bit PowerShell if we are 64-bit. SysWOW64 holds the 32-bit copy;
# the naming looks backwards and is not.
if ([IntPtr]::Size -eq 8) {
  $ps32 = "$env:SystemRoot\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path $ps32)) { Write-Error 'no 32-bit PowerShell available'; exit 1 }
  # Pass -Dll through only when it was actually given; an empty string is a missing
  # argument to PowerShell's parameter binder, not an empty one.
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-ProcName', $ProcName)
  if ($Dll) { $fwd += @('-Dll', $Dll) }
  & $ps32 @fwd
  exit $LASTEXITCODE
}

if (-not $Dll) { $Dll = Join-Path (Split-Path $PSCommandPath -Parent) 'm59-agent\m59agent.dll' }
$Dll = (Resolve-Path $Dll -ErrorAction SilentlyContinue).Path
if (-not $Dll) { Write-Error 'm59agent.dll not found - build it first'; exit 1 }

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
}
'@

$PROCESS_ALL = 0x1F0FFF
$MEM_COMMIT_RESERVE = 0x3000
$PAGE_RW = 0x04

function Inject-Into($proc, $dllPath) {
  # Skip a client that already carries the agent. LoadLibrary on an already-loaded
  # module only bumps its refcount and never re-runs DllMain, so a second injection
  # would silently do nothing and look like it worked.
  foreach ($m in $proc.Modules) {
    if ($m.ModuleName -ieq 'm59agent.dll') { "pid $($proc.Id): already injected"; return }
  }

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
foreach ($proc in $procs) { Inject-Into $proc $Dll }

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

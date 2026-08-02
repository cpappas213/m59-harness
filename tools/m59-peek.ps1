<#
  Read the Meridian client's own idea of where it is, out of its process memory.

    powershell -File tools/m59-peek.ps1 -PlayerId 7225
    powershell -File tools/m59-peek.ps1 -PlayerId 7225 -RoomId 483 -Watch

  WHY READ MEMORY AT ALL

  Driving the client with keystrokes means the CLIENT decides where it ends up — it
  runs its own collision, its own speed, its own animation. That is the whole point:
  nothing we send can put it somewhere its own geometry disagrees with. But it also
  means we cannot know where it got to by counting the moves we asked for. The
  position has to be read back from the thing that owns it.

  The protocol cannot answer this either. The server never tells the mover where it
  moved (Room.SomethingMoved skips the mover), so the only authority on the client's
  current position is the client.

  HOW THE STRUCT IS FOUND

  `player` is a global player_info (clientd3d/game.h:31-54), laid out as
      +0 id  +4 name_res  +8 icon_res  +12 room_id  +16 room_res
      +20 room_name_res  +24 room_security  +28 x  +32 y  +36 angle
  all 4-byte on a 32-bit build. We know the player's object id and current room from
  the proxy, which learned both from the protocol — so the search is for two known
  values at a known distance apart, which is specific enough to land on one address.
  No offsets are hard-coded and nothing needs re-finding when the client is patched.
#>
param(
  [Parameter(Mandatory = $true)][int]$PlayerId,
  [int]$RoomId = 0,
  [string]$ProcName = 'Meridian',
  [switch]$Watch,
  [int]$IntervalMs = 500
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Mem {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")]
  static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  struct MBI {
    public ulong BaseAddress, AllocationBase;
    public int AllocationProtect, __a;
    public ulong RegionSize;
    public int State, Protect, Type, __b;
  }

  const int READ = 0x0010, QUERY = 0x0400;   // VM_READ | QUERY_INFORMATION
  const int COMMIT = 0x1000;
  // Skip guard/no-access pages; reading them is an error and they never hold data.
  const int NOACCESS = 0x01, GUARD = 0x100;

  static IntPtr h = IntPtr.Zero;
  public static bool Open(int pid) {
    h = OpenProcess(READ | QUERY, false, pid);
    return h != IntPtr.Zero;
  }
  public static void Close() { if (h != IntPtr.Zero) CloseHandle(h); h = IntPtr.Zero; }

  public static byte[] Read(long addr, int len) {
    byte[] b = new byte[len]; IntPtr got;
    if (!ReadProcessMemory(h, (IntPtr)addr, b, (IntPtr)len, out got)) return null;
    if ((int)got != len) return null;
    return b;
  }

  // Every committed, readable region below 4GB — the target is a 32-bit process.
  public static List<long[]> Regions() {
    var outp = new List<long[]>();
    ulong addr = 0x10000;
    MBI m;
    while (addr < 0x7FFF0000UL) {
      if (VirtualQueryEx(h, (IntPtr)(long)addr, out m, (IntPtr)Marshal.SizeOf(typeof(MBI))) == IntPtr.Zero) break;
      bool readable = m.State == COMMIT
                      && (m.Protect & NOACCESS) == 0 && (m.Protect & GUARD) == 0;
      if (readable && m.RegionSize > 0 && m.RegionSize < 0x8000000UL)
        outp.Add(new long[] { (long)m.BaseAddress, (long)m.RegionSize });
      if (m.RegionSize == 0) break;
      addr = m.BaseAddress + m.RegionSize;
    }
    return outp;
  }

  // Addresses where int32 at +0 == a AND int32 at +offB == b.
  public static List<long> Find(int a, int b, int offB, bool matchB) {
    var hits = new List<long>();
    foreach (var r in Regions()) {
      byte[] buf = Read(r[0], (int)r[1]);
      if (buf == null) continue;
      for (int i = 0; i + offB + 4 <= buf.Length; i += 4) {
        if (BitConverter.ToInt32(buf, i) != a) continue;
        if (matchB && BitConverter.ToInt32(buf, i + offB) != b) continue;
        hits.Add(r[0] + i);
      }
    }
    return hits;
  }
}
'@

$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Error "no $ProcName process running"; exit 1 }
if (-not [Mem]::Open($proc.Id)) { Write-Error "could not open process $($proc.Id) for reading"; exit 1 }

# id at +0, room_id at +12.
$hits = [Mem]::Find($PlayerId, $RoomId, 12, ($RoomId -ne 0))
if ($hits.Count -eq 0) {
  Write-Error "player_info not found (id=$PlayerId room=$RoomId). Is the character in game?"
  [Mem]::Close(); exit 2
}

# The struct also holds x, y, angle. A candidate whose angle is outside 0..4095 is
# some other memory that merely happens to hold the id — cheap sanity filter.
$good = @()
foreach ($h in $hits) {
  $b = [Mem]::Read($h, 40)
  if ($b -eq $null) { continue }
  $angle = [BitConverter]::ToInt32($b, 36)
  if ($angle -ge 0 -and $angle -lt 4096) { $good += $h }
}
if ($good.Count -eq 0) { $good = $hits }

$addr = $good[0]
Write-Host ("player_info at 0x{0:X}  ({1} candidate(s))" -f $addr, $good.Count)

function Show($addr) {
  $b = [Mem]::Read($addr, 40)
  if ($b -eq $null) { Write-Host "read failed"; return }
  $room  = [BitConverter]::ToInt32($b, 12)
  $x     = [BitConverter]::ToInt32($b, 28)
  $y     = [BitConverter]::ToInt32($b, 32)
  $angle = [BitConverter]::ToInt32($b, 36)
  # Client FINENESS is 1024 per square; the server's rows/cols are 1-based, hence +1.
  $col = [math]::Floor($x / 1024) + 1
  $row = [math]::Floor($y / 1024) + 1
  $deg = [math]::Round($angle * 360 / 4096)
  "{0}" -f (@{ room = $room; x = $x; y = $y; col = $col; row = $row;
               angle = $angle; degrees = $deg } | ConvertTo-Json -Compress)
}

if ($Watch) {
  while ($true) { Show $addr; Start-Sleep -Milliseconds $IntervalMs }
} else {
  Show $addr
}
[Mem]::Close()

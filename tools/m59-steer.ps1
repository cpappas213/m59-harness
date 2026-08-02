<#
  Steer the Meridian client to a square by pressing keys and watching its own memory.

    powershell -File tools/m59-steer.ps1 -PlayerId 7221 -RoomId 477 -ToRow 44 -ToCol 50

  THE POINT OF DOING IT THIS WAY

  Every earlier attempt drove the character by telling the SERVER where it now was
  and forging a matching packet to the client. That works, and it crashes the client:
  a forged position is a coordinate WE chose being handed to GetFloorBase(x,y), which
  indexes the current room's floor grid, and anything the room cannot contain reads
  off the end of it (three dumps, all ACCESS_VIOLATION at a fixed 0x994000).

  Here the client is the one moving. It runs its own collision, its own speed, its own
  animation, and it tells the server itself, exactly as it would for a person at the
  keyboard. There is no position for us to get wrong, so there is nothing to desync
  and nothing to crash. What we do instead is close the loop: read where it actually
  got to, and decide what to press next.

  Keys, established by pressing each one and watching the struct move:
      W            forward            A / D   strafe
      Left/Right   turn               S       backward
  Arrow keys turn, WASD translates. Up/NumPad8 do nothing.

  Angles run 0..4095 with 0 along +x and increasing toward +y (moveobj.c's
  turnToFace maps dx>0,dy>0 to the first eighth). Left arrow DECREASES the angle.
#>
param(
  [Parameter(Mandatory = $true)][int]$PlayerId,
  [Parameter(Mandatory = $true)][int]$RoomId,
  # One square at a time, deliberately. Steering straight at a distant target walks
  # into walls and reports "stuck", which is honest but useless. The wall-avoidance
  # belongs where the geometry already lives — m59-map's A* over the room grid — so
  # the caller feeds this the next square on that path, and this stays one job.
  [Parameter(Mandatory = $true)][int]$ToRow,      # server 1-based row
  [Parameter(Mandatory = $true)][int]$ToCol,      # server 1-based col
  [int]$MaxSeconds = 45,
  [int]$ToleranceUnits = 420                      # client units; 1024 = one square
)

Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class S {
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a,bool i,int p);
 [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,IntPtr s,out IntPtr r);
 [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h,IntPtr a,out MBI m,IntPtr l);
 [StructLayout(LayoutKind.Sequential)] struct MBI {
   public ulong BaseAddress,AllocationBase; public int AllocationProtect,__a;
   public ulong RegionSize; public int State,Protect,Type,__b; }
 static IntPtr h;
 public static bool Open(int pid){ h=OpenProcess(0x0410,false,pid); return h!=IntPtr.Zero; }
 public static byte[] Read(long a,int n){ byte[] b=new byte[n]; IntPtr g;
   if(!ReadProcessMemory(h,(IntPtr)a,b,(IntPtr)n,out g)||(int)g!=n) return null; return b; }
 // id at +0 and room_id at +12, with a plausible angle at +36 as the tie-break.
 public static long Find(int id,int room){
   ulong addr=0x10000; MBI m;
   while(addr<0x7FFF0000UL){
     if(VirtualQueryEx(h,(IntPtr)(long)addr,out m,(IntPtr)Marshal.SizeOf(typeof(MBI)))==IntPtr.Zero) break;
     if(m.State==0x1000 && (m.Protect&0x01)==0 && (m.Protect&0x100)==0 && m.RegionSize>0 && m.RegionSize<0x8000000UL){
       byte[] buf=Read((long)m.BaseAddress,(int)m.RegionSize);
       if(buf!=null) for(int i=0;i+40<=buf.Length;i+=4)
         if(BitConverter.ToInt32(buf,i)==id && BitConverter.ToInt32(buf,i+12)==room){
           int ang=BitConverter.ToInt32(buf,i+36);
           if(ang>=0&&ang<4096) return (long)m.BaseAddress+i; }
     }
     if(m.RegionSize==0) break; addr=m.BaseAddress+m.RegionSize; }
   return 0; }

 [StructLayout(LayoutKind.Sequential)] struct KI { public ushort wVk,wScan; public uint dwFlags,time; public IntPtr ex; }
 [StructLayout(LayoutKind.Sequential)] struct INP { public uint type; public KI ki; public int p1,p2; }
 [DllImport("user32.dll")] static extern uint SendInput(uint n,INP[] i,int s);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr pid);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

 // Windows refuses SetForegroundWindow from a process that does not already own the
 // foreground — it just flashes the taskbar. Borrowing the current foreground
 // thread's input state for the duration is the documented way round it, and it is
 // needed here because HandleKeys reads nothing unless the client has focus.
 public static bool Focus(IntPtr hwnd){
   ShowWindow(hwnd,9);
   if(GetForegroundWindow()==hwnd) return true;
   uint me=GetCurrentThreadId();
   uint fg=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
   uint target=GetWindowThreadProcessId(hwnd,IntPtr.Zero);
   if(fg!=me) AttachThreadInput(me,fg,true);
   if(target!=me) AttachThreadInput(me,target,true);
   for(int i=0;i<5 && GetForegroundWindow()!=hwnd;i++){
     SetForegroundWindow(hwnd); System.Threading.Thread.Sleep(60); }
   if(target!=me) AttachThreadInput(me,target,false);
   if(fg!=me) AttachThreadInput(me,fg,false);
   return GetForegroundWindow()==hwnd; }
 static bool Ext(ushort vk){ return vk==0x26||vk==0x28||vk==0x25||vk==0x27; }
 public static void Key(ushort vk,bool down){
   var a=new INP[1]; a[0].type=1; a[0].ki.wVk=vk;
   a[0].ki.dwFlags=(down?0u:2u)|(Ext(vk)?1u:0u);
   SendInput(1,a,Marshal.SizeOf(typeof(INP))); }
}
'@

$FINENESS = 1024

# READ THE PLAYER'S OWN BINDINGS, DO NOT ASSUME WASD.
#
# This is a 1996 game and people hold strong opinions about its controls. The client
# reads them from the [keys] section of config.ini beside the executable
# (module/merintr/merintr.c:865-910), one line per action: forward=w, left=left,
# slideleft=a, and so on. Anything absent falls back to the compiled-in default, and
# classickeybindings=true throws the whole section away in favour of the old table.
function Get-Bindings([string]$clientDir) {
  $ini = Join-Path $clientDir 'config.ini'
  $map = @{ forward = 'w'; backward = 's'; left = 'left'; right = 'right'
            slideleft = 'a'; slideright = 'd' }
  if (Test-Path $ini) {
    $inKeys = $false
    foreach ($line in Get-Content $ini) {
      if ($line -match '^\s*\[(.+)\]') { $inKeys = ($Matches[1] -eq 'keys'); continue }
      if (-not $inKeys) { continue }
      if ($line -match '^\s*([^;=\s]+)\s*=\s*(.+?)\s*$') {
        $name = $Matches[1].ToLower(); $val = $Matches[2].ToLower()
        if ($map.ContainsKey($name)) { $map[$name] = $val }
        if ($name -eq 'classickeybindings' -and $val -eq 'true') {
          Write-Warning 'classickeybindings=true — the client ignores [keys] and uses the old table; these bindings may be wrong'
        }
      }
    }
  } else {
    Write-Warning "no config.ini beside the client; assuming default bindings"
  }
  $map
}

# Only the keys this script presses need translating. A bare letter or digit is its
# own virtual-key code in ASCII; the named ones are not.
$NAMED = @{ 'left' = 0x25; 'right' = 0x27; 'up' = 0x26; 'down' = 0x28
            'space' = 0x20; 'enter' = 0x0D; 'tab' = 0x09; 'home' = 0x24; 'end' = 0x23
            'pageup' = 0x21; 'pagedown' = 0x22 }
function To-VK([string]$name) {
  $n = ($name -split '\+')[0].Trim().ToLower()      # ignore modifiers like "+any"
  if ($NAMED.ContainsKey($n)) { return [uint16]$NAMED[$n] }
  if ($n.Length -eq 1) { return [uint16][byte][char]([string]$n).ToUpper() }
  return [uint16]0
}

$proc = Get-Process -Name Meridian -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Error 'no Meridian client running'; exit 1 }

$bind = Get-Bindings (Split-Path $proc.Path -Parent)
$VK_W     = To-VK $bind.forward
$VK_LEFT  = To-VK $bind.left
$VK_RIGHT = To-VK $bind.right
if ($VK_W -eq 0 -or $VK_LEFT -eq 0 -or $VK_RIGHT -eq 0) {
  Write-Error "could not translate bindings: forward=$($bind.forward) left=$($bind.left) right=$($bind.right)"
  exit 5
}
Write-Host "bindings: forward=$($bind.forward) turn=$($bind.left)/$($bind.right)"
if (-not [S]::Open($proc.Id)) { Write-Error 'cannot open the client for reading'; exit 1 }
$addr = [S]::Find($PlayerId, $RoomId)
if ($addr -eq 0) { Write-Error "player_info not found for id=$PlayerId room=$RoomId"; exit 2 }

function Get-Pos {
  $b = [S]::Read($addr, 40)
  if ($null -eq $b) { return $null }
  @{ room  = [BitConverter]::ToInt32($b, 12)
     x     = [BitConverter]::ToInt32($b, 28)
     y     = [BitConverter]::ToInt32($b, 32)
     angle = [BitConverter]::ToInt32($b, 36) }
}
function Tap([uint16]$vk, [int]$ms) {
  [S]::Key($vk, $true); Start-Sleep -Milliseconds $ms; [S]::Key($vk, $false)
}

# Server rows/cols are 1-based; client units put square (1,1) at 0..1023.
$targetX = ($ToCol - 1) * $FINENESS + 512
$targetY = ($ToRow - 1) * $FINENESS + 512

if (-not [S]::Focus($proc.MainWindowHandle)) {
  Write-Error 'could not bring the client to the foreground; HandleKeys ignores input unless it has focus (key.c:184)'
  exit 3
}
Start-Sleep -Milliseconds 250

$start = Get-Date
$last = $null; $stuck = 0
while ($true) {
  $p = Get-Pos
  if ($null -eq $p) { Write-Error 'lost the client'; exit 4 }
  if ($p.room -ne $RoomId) { "left the room (now $($p.room)) — stopping"; break }

  $dx = $targetX - $p.x; $dy = $targetY - $p.y
  $dist = [math]::Sqrt($dx * $dx + $dy * $dy)
  if ($dist -le $ToleranceUnits) {
    "arrived: row $([math]::Floor($p.y / $FINENESS) + 1), col $([math]::Floor($p.x / $FINENESS) + 1) (within $([int]$dist) units)"
    break
  }
  if (((Get-Date) - $start).TotalSeconds -gt $MaxSeconds) { "gave up after ${MaxSeconds}s, $([int]$dist) units short"; break }

  # Shortest signed turn onto the bearing of the target.
  $want = [math]::Atan2($dy, $dx) / (2 * [math]::PI) * 4096
  $err = ($want - $p.angle) % 4096
  if ($err -gt 2048) { $err -= 4096 }; if ($err -lt -2048) { $err += 4096 }

  if ([math]::Abs($err) -gt 160) {
    # ~1900 units/sec measured; clamp so a big turn is still several closed-loop
    # corrections rather than one open-loop guess.
    $ms = [math]::Min(350, [math]::Max(40, [int]([math]::Abs($err) / 1900 * 1000)))
    Tap ($(if ($err -lt 0) { $VK_LEFT } else { $VK_RIGHT })) $ms
  } else {
    Tap $VK_W ([math]::Min(500, [math]::Max(90, [int]($dist / 12))))
  }

  # A wall the geometry did not predict shows up as distance refusing to fall.
  if ($null -ne $last -and [math]::Abs($last - $dist) -lt 25) { $stuck++ } else { $stuck = 0 }
  if ($stuck -ge 8) { "stuck $([int]$dist) units short — something is in the way"; break }
  $last = $dist
  Start-Sleep -Milliseconds 60
}

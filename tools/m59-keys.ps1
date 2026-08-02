<#
  Send real keyboard input to the Meridian client.

    powershell -File tools/m59-keys.ps1 -Key Up -DurationMs 600
    powershell -File tools/m59-keys.ps1 -Key Left -DurationMs 200

  WHY SendInput AND NOT PostMessage

  The client does not act on key MESSAGES for movement. HandleKeys polls the whole
  keyboard every frame with GetKeyboardState and performs an action for every key
  that is currently down (clientd3d/key.c:171-215) — which is how it supports holding
  several arrows at once. PostMessage(WM_KEYDOWN) never touches the thread's key
  state table, so it moves nothing. SendInput does, because it is real system input.

  THE COST, STATED PLAINLY

  Four lines above that poll:

      if (GetFocus() != hMain)
         return;

  so the client only reads the keyboard when its window has focus. Driving it this
  way therefore requires the Meridian window to be foreground, and it uses the real
  keyboard — if you type while it runs, your keystrokes and ours go to the same
  place. That is the trade for having the CLIENT decide where it walks: it runs its
  own collision and its own speed, so nothing we send can put it somewhere its own
  geometry disagrees with, which is the failure that crashed it repeatedly when we
  were forging positions instead.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('Up','Down','Left','Right')][string]$Key,
  [int]$DurationMs = 300,
  [string]$ProcName = 'Meridian'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class Keys {
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public KEYBDINPUT ki; public int pad1, pad2; }

  [DllImport("user32.dll", SetLastError=true)]
  static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  const uint KEYBOARD = 1;
  const uint KEYUP = 0x0002, EXTENDED = 0x0001, SCANCODE = 0x0008;

  // Arrow keys are "extended" — the flag has to be set or the scan code is
  // ambiguous with the numeric keypad, which this client already has a documented
  // bug around (KeyUpHack, key.c:423).
  static bool IsExtended(ushort vk) {
    return vk == 0x26 || vk == 0x28 || vk == 0x25 || vk == 0x27;   // up down left right
  }

  public static void Focus(IntPtr hwnd) {
    ShowWindow(hwnd, 9);            // SW_RESTORE, in case it is minimised
    SetForegroundWindow(hwnd);
  }
  public static bool IsForeground(IntPtr hwnd) { return GetForegroundWindow() == hwnd; }

  public static void Press(ushort vk, bool down) {
    var inp = new INPUT[1];
    inp[0].type = KEYBOARD;
    inp[0].ki.wVk = vk;
    inp[0].ki.wScan = 0;
    inp[0].ki.dwFlags = (down ? 0u : KEYUP) | (IsExtended(vk) ? EXTENDED : 0u);
    inp[0].ki.dwExtraInfo = IntPtr.Zero;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

$VK = @{ Up = 0x26; Down = 0x28; Left = 0x25; Right = 0x27 }

$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Error "no $ProcName process running"; exit 1 }
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "client has no main window"; exit 1 }

[Keys]::Focus($hwnd)
Start-Sleep -Milliseconds 250
if (-not [Keys]::IsForeground($hwnd)) {
  Write-Warning "could not bring the client to the foreground; HandleKeys will ignore input (key.c:184)"
}

$vk = [uint16]$VK[$Key]
[Keys]::Press($vk, $true)
Start-Sleep -Milliseconds $DurationMs
[Keys]::Press($vk, $false)
Write-Host "sent $Key for ${DurationMs}ms"

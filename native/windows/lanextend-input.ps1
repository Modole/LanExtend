$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class LanExtendInput {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();

    private const uint MOUSE_LEFT_DOWN = 0x0002;
    private const uint MOUSE_LEFT_UP = 0x0004;
    private const uint MOUSE_RIGHT_DOWN = 0x0008;
    private const uint MOUSE_RIGHT_UP = 0x0010;
    private const uint MOUSE_MIDDLE_DOWN = 0x0020;
    private const uint MOUSE_MIDDLE_UP = 0x0040;
    private const uint MOUSE_WHEEL = 0x0800;
    private const uint MOUSE_HWHEEL = 0x1000;
    private const uint KEY_UP = 0x0002;
    private const uint KEY_EXTENDED = 0x0001;

    private static readonly HashSet<byte> PressedKeys = new HashSet<byte>();
    private static readonly HashSet<string> PressedButtons = new HashSet<string>();

    private static bool IsExtended(int virtualKey) {
        return (virtualKey >= 0x21 && virtualKey <= 0x2E)
            || virtualKey == 0x5B || virtualKey == 0x5C || virtualKey == 0xA3 || virtualKey == 0xA5;
    }

    public static void Initialize() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    }

    public static void Pointer(int x, int y) {
        SetCursorPos(x, y);
    }

    public static void Button(string button, bool down) {
        uint flag;
        switch ((button ?? "left").ToLowerInvariant()) {
            case "right": flag = down ? MOUSE_RIGHT_DOWN : MOUSE_RIGHT_UP; break;
            case "middle": flag = down ? MOUSE_MIDDLE_DOWN : MOUSE_MIDDLE_UP; break;
            default: flag = down ? MOUSE_LEFT_DOWN : MOUSE_LEFT_UP; button = "left"; break;
        }
        mouse_event(flag, 0, 0, 0, UIntPtr.Zero);
        if (down) PressedButtons.Add(button); else PressedButtons.Remove(button);
    }

    public static void Wheel(int deltaX, int deltaY) {
        if (deltaY != 0) mouse_event(MOUSE_WHEEL, 0, 0, deltaY * 120, UIntPtr.Zero);
        if (deltaX != 0) mouse_event(MOUSE_HWHEEL, 0, 0, deltaX * 120, UIntPtr.Zero);
    }

    public static void Key(int virtualKey, bool down) {
        if (virtualKey < 0 || virtualKey > 255) return;
        byte key = (byte)virtualKey;
        bool extended = IsExtended(virtualKey);
        uint flags = (down ? 0u : KEY_UP) | (extended ? KEY_EXTENDED : 0u);
        keybd_event(key, 0, flags, UIntPtr.Zero);
        if (down) PressedKeys.Add(key); else PressedKeys.Remove(key);
    }

    public static void ReleaseAll() {
        foreach (byte key in new List<byte>(PressedKeys)) {
            keybd_event(key, 0, KEY_UP | (IsExtended(key) ? KEY_EXTENDED : 0u), UIntPtr.Zero);
        }
        PressedKeys.Clear();
        foreach (string button in new List<string>(PressedButtons)) Button(button, false);
        PressedButtons.Clear();
    }
}
'@

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$InputReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $Utf8NoBom)
$OutputWriter = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $Utf8NoBom)
$OutputWriter.AutoFlush = $true
[LanExtendInput]::Initialize()
$OutputWriter.WriteLine('{"event":"ready","trusted":true}')

function Write-HelperResponse {
    param(
        [string]$RequestId,
        [bool]$Ok,
        [object]$Payload,
        [string]$ErrorMessage
    )
    if ([string]::IsNullOrWhiteSpace($RequestId)) { return }
    $response = [ordered]@{ event = 'response'; requestId = $RequestId; ok = $Ok }
    if ($null -ne $Payload) {
        foreach ($property in $Payload.PSObject.Properties) { $response[$property.Name] = $property.Value }
    }
    if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $response['error'] = $ErrorMessage }
    $OutputWriter.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
}

function Set-FileClipboard {
    param([object[]]$Paths)
    $items = [System.Collections.Specialized.StringCollection]::new()
    foreach ($path in @($Paths)) {
        $value = [string]$path
        if (-not [string]::IsNullOrWhiteSpace($value) -and (Test-Path -LiteralPath $value)) {
            [void]$items.Add([System.IO.Path]::GetFullPath($value))
        }
    }
    if ($items.Count -eq 0) { throw 'No files are available for the clipboard' }
    $lastError = $null
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            [System.Windows.Forms.Clipboard]::SetFileDropList($items)
            return
        } catch {
            $lastError = $_.Exception
            Start-Sleep -Milliseconds 80
        }
    }
    throw $lastError
}

try {
    while (($line = $InputReader.ReadLine()) -ne $null) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $message = $line | ConvertFrom-Json
        if ($message.command -eq 'quit') { break }
        if ($message.command -eq 'clipboard-read') {
            try {
                $paths = @()
                if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
                    $paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })
                }
                Write-HelperResponse -RequestId ([string]$message.requestId) -Ok $true -Payload ([pscustomobject]@{
                    paths = $paths
                    revision = [LanExtendInput]::GetClipboardSequenceNumber()
                }) -ErrorMessage ''
            } catch {
                Write-HelperResponse -RequestId ([string]$message.requestId) -Ok $false -Payload $null -ErrorMessage $_.Exception.Message
            }
            continue
        }
        if ($message.command -eq 'clipboard-write') {
            try {
                Set-FileClipboard -Paths @($message.paths)
                Write-HelperResponse -RequestId ([string]$message.requestId) -Ok $true -Payload ([pscustomobject]@{
                    revision = [LanExtendInput]::GetClipboardSequenceNumber()
                }) -ErrorMessage ''
            } catch {
                Write-HelperResponse -RequestId ([string]$message.requestId) -Ok $false -Payload $null -ErrorMessage $_.Exception.Message
            }
            continue
        }
        if ($message.command -ne 'input' -or $null -eq $message.event) { continue }
        $event = $message.event
        switch ($event.kind) {
            'pointer' { [LanExtendInput]::Pointer([int]$event.x, [int]$event.y) }
            'button' { [LanExtendInput]::Button([string]$event.button, [bool]$event.down) }
            'wheel' { [LanExtendInput]::Wheel([int]$event.deltaX, [int]$event.deltaY) }
            'key' { [LanExtendInput]::Key([int]$event.vk, [bool]$event.down) }
            'releaseAll' { [LanExtendInput]::ReleaseAll() }
        }
    }
} finally {
    [LanExtendInput]::ReleaseAll()
    $OutputWriter.Flush()
}

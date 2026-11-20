# Windows local production validation

The Production Readiness screen performs a safe, pre-production diagnostic. It does not upload a video or publish anything.

## Requirements

- Node.js 20.17 or newer.
- A writable project `data` directory and writable Windows temporary directory.
- FFmpeg with the `libx264` and `aac` encoders and the `zoompan` and `vignette` filters. These are used by the local CineCode renderer.
- FFprobe is recommended. If it is unavailable, AgentTube uses its FFmpeg metadata fallback and records a warning.

## Check the Windows installation

Open a new PowerShell window in the project directory and run:

```powershell
node --version
where.exe ffmpeg
where.exe ffprobe
ffmpeg -version
ffmpeg -hide_banner -encoders | Select-String "libx264|aac"
ffmpeg -hide_banner -filters | Select-String "zoompan|vignette"
ffprobe -version
```

If FFmpeg is missing, install a full Windows build:

```powershell
winget install Gyan.FFmpeg
```

Close and reopen PowerShell after installation, then repeat the commands above. If the executables are not on PATH, set the exact paths reported by your installation:

```powershell
$env:FFMPEG_PATH = "C:\\path\\to\\ffmpeg.exe"
$env:FFPROBE_PATH = "C:\\path\\to\\ffprobe.exe"
```

For a persistent configuration, add those two variables through Windows Environment Variables rather than using `setx` with a guessed path.

## Run the AgentTube diagnostic

1. Start AgentTube using the normal project start command.
2. Open the dashboard and go to **Production readiness**.
3. Leave the paid image and paid video probe options unchecked unless you explicitly want to spend provider quota or credits.
4. Select **Run verified check**.
5. Review the **Local Windows / Node runtime**, **Audio/video assembly**, and **YouTube channel access** results.

The local runtime check verifies the Node version and write permissions. The FFmpeg check reports the executable paths and version, tests H.264/AAC and CineCode filters, creates a short local MP4, verifies its dimensions and audio stream, and decodes it. YouTube access checks the connected channel and required OAuth scopes; it does not upload a video.

## Interpreting results

- **Passed:** the tested component completed its real check.
- **Warning:** the core path worked with a documented fallback, such as FFmpeg metadata parsing without FFprobe.
- **Failed:** follow the remediation text shown under that check, correct the local configuration, and run the check again.
- A readiness result expires after 24 hours. A failed blocking check prevents protected autonomous generation/publishing until a fresh run passes.

A green GitHub Actions run validates the CI environment only. Run this check on the Windows PC to verify its actual executable paths, permissions, credentials, and YouTube authorization.

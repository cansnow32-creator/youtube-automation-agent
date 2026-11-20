# Background music and audio mixing

AgentTube can mix a locally supplied music file under the generated narration during final video assembly. No music-generation or download service is called.

## Configure a music asset

In the Video Concept Studio, select a pending concept, choose a local audio file in the Background music section, select its license, confirm usage rights, and upload it before approving the concept. The app stores the file locally and attaches its metadata to `audioDirection.musicAsset`. Keep `audioDirection.music` as a descriptive mood only; the concept model must not invent a local file path or copy an existing track. The JSON structure below documents the stored representation.

```json
{
  "audioDirection": {
    "narration": "warm documentary delivery",
    "pacing": "measured",
    "music": "subtle cinematic ambient",
    "musicAsset": {
      "enabled": true,
      "path": "C:/AgentTube/assets/ambient-bed.wav",
      "title": "Ambient Bed",
      "creator": "Creator or rights holder",
      "licenseType": "user_owned",
      "rightsConfirmed": true,
      "volume": 0.18,
      "loop": true,
      "fadeInSeconds": 2,
      "fadeOutSeconds": 3
    }
  }
}
```

Supported `licenseType` values are `user_owned`, `public_domain`, `cc0`, `cc_by`, `cc_by_sa`, and `commercial_license`. The operator must set `rightsConfirmed: true`; CC BY and CC BY-SA require an attribution string. Commercial licenses must include `licenseName` or `licenseUrl`. Optional record fields include `sourceUrl`, `licenseUrl`, `licenseName`, and `attribution`.

The default music volume is 0.18 and allowed values are 0.01–0.5. Music loops to cover the video by default. Fade durations default to 2 seconds in and 3 seconds out and must be between 0 and 30 seconds.

## Safety and output behavior

- No music asset, or `enabled: false`, leaves the generated narration unchanged.
- A configured asset is not mixed unless the operator confirms commercial-use rights and supplies a supported license type.
- The local file must exist, be non-empty, and contain a readable audio stream.
- FFmpeg mixes the track under narration, applies fades and a limiter, and preserves the source video stream.
- The mix is written to a temporary file, decoded and probed, then promoted to the final output only after duration and audio-stream checks pass.
- Mix metadata, license details, attribution, track duration, volume and mix time are retained in `assets.backgroundMusic`.
- If a configured track fails validation or mixing, final assembly fails closed rather than silently dropping the requested music. Automatic publishing remains separate and requires the existing approval gates.

The TTS provider still handles narration and pacing instructions only. Background music is applied locally in post-production.

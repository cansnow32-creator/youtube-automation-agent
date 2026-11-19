# CineCode local renderer integration

The `cinecode` video-provider option is implemented as a native local renderer in this repository. It does **not** launch the upstream CineCode agent skill or download its agent workspace. The integration selectively adapts the scene-oriented film workflow and camera vocabulary from [sarpstar/cinecode](https://github.com/sarpstar/cinecode) into tested AgentTube services.

## What runs when CineCode is selected

1. The production pipeline uses the approved concept's visual direction and scene plan.
2. The existing image-generation stage supplies real local image assets.
3. `utils/cinecode-renderer.js` turns each image into a short scene using slow camera push/pan motion, palette-based color grading, vignette, and fade-in/fade-out.
4. The existing FFmpeg timeline assembler joins the scenes and adds the narration track.
5. The normal subtitle pass burns approved typography and placement into the final MP4.
6. The production manifest records the requested and actual provider as `cinecode`, plus scene paths and renderer metadata.

The renderer is local and does not call a video-generation API. It still depends on real image assets from the configured image-generation provider; that image provider may incur charges. FFmpeg must also be installed and working. If those prerequisites are missing, CineCode fails closed and is **not** silently replaced by the slideshow provider.

## Current boundaries

- This first native adapter is a 2D image-to-motion renderer. It is not yet the full upstream CineCode HTML/Three.js/WebGL scene authoring system.
- It does not yet create persistent 3D characters, facial performances, lip-sync, or interactive game footage.
- Subtitle typography and placement are applied. Per-word subtitle animation is recorded as unsupported by the current SRT renderer.
- OpenAI TTS instructions and mapped ElevenLabs voice settings can apply narration/pacing direction. Gemini TTS currently retains the direction as metadata but does not apply it. Music direction is not yet rendered.
- Uploaded reference videos are stored locally, sampled into still frames, and analyzed by the configured local Ollama model for high-level style guidance only. The analysis must not be used to copy footage, dialogue, music, characters, logos, or distinctive protected designs.

## Upstream attribution

CineCode is an independent upstream project. Review its current MIT license and notices before redistributing any upstream source files. This integration currently implements its own AgentTube renderer and does not vendor the upstream skill or its source files.

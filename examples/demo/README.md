# Demo clip

A small, redistributable sample so the setup and analysis flow can be run
without supplying your own recording. These are the repository's bundled demo
inputs; documentation screenshots and test fixtures have separate purposes.

| File | Detail |
| --- | --- |
| `scene.mp4` | 1920 × 1080, 24 fps, 79.96 s, no audio, 7.4 MiB |
| `clean-frame.jpg` | 1920 × 1080, the reset reference for the same framing, no people present |

## What it shows

A fixed camera above a shared study space with six tables. Seats fill and empty
over the recording, and objects are left on and cleared from tabletops. It is a
stand-in for restaurant seating, not restaurant footage: no service, no table
turnover under staff control, and no independent labels. Treat any result from
it as a demonstration that the pipeline runs end to end, never as accuracy
evidence. [Validation](../../docs/VALIDATION.md) records what is still required.

People appear in this recording and are shown unaltered, with their consent to
include it here.

## Provenance

Transcoded for distribution from a 3840 × 2160 master at 99.5 Mbit/s, using
H.264 CRF 28 with audio removed. Framing, duration and frame rate are unchanged,
so the clean reference still matches the source aspect ratio exactly. The master
is not in this repository; a 948 MiB file cannot be cloned or pushed.

```
sha256  scene.mp4        4afda94fbb0bebd9ba5a7870ea3aed21234da66eafd66f179c74e98c189593a3
sha256  clean-frame.jpg  ed9283dac416481814defb509b6a9770168b8a0a650e55a9476982dc6b281af2
```

## Use it

Start the application using the [README](../../README.md#start-locally), then
follow the [step-by-step demo walkthrough](../../docs/SETUP.md#try-the-demo).
Under **Upload a recording**, select manual table drawing, click **Choose video**,
and select `scene.mp4`. Upload `clean-frame.jpg` when asked for a clean reference
and choose a schematic floor plan. Review one table first, then add the others
when you are comfortable. Nothing here is pre-approved.

You can select your own material from any local folder. `examples/videos` and
`examples/mappings` are optional convenience folders that start empty in version
control.

# Demo recordings

Two small samples so the setup and analysis flow can be run without supplying
your own recording. These are the repository's bundled demo
inputs; documentation screenshots and test fixtures have separate purposes.

| Scene | File | Detail |
| --- | --- | --- |
| Scene One | [scene.mp4](scene.mp4) | 1920 × 1080, 24 fps, 79.96 s, no audio, 7.4 MiB |
| Scene One | [clean-frame.jpg](clean-frame.jpg) | 1920 × 1080, the reset reference for the same framing, no people present |
| Scene Two | [scene-two.mp4](scene-two.mp4) | 1920 × 1080, 24 fps, 63.00 s (source 0:00–1:03), no audio, 3.54 MiB (3.72 MB) |
| Scene Two | [scene-two-clean-frame.jpg](scene-two-clean-frame.jpg) | 4000 × 2250, the supplied clean reference for Scene Two, no people present, 3.31 MiB |

## What they show

### Scene One

A fixed camera above a shared study space with six tables. Seats fill and empty
over the recording, and objects are left on and cleared from tabletops.

People appear in this recording and are shown unaltered, with their consent to
include it here.

### Scene Two

A view of booth seating and a small freestanding table in a shared study space.
The supplied clean photo shows the empty seating area and cleared tabletops.
Use its own reference photo when setting up this recording.

Both scenes are stand-ins for restaurant seating: they have no restaurant service,
table turnover under staff control, or independent labels. Treat results as
demonstrations that the pipeline runs end to end, never as accuracy evidence.
[Validation](../../docs/VALIDATION.md) records what is still required.

## Provenance

### Scene One

Transcoded for distribution from a 3840 × 2160 master at 99.5 Mbit/s, using
H.264 CRF 28 with audio removed. Framing, duration and frame rate are unchanged,
so the clean reference still matches the source aspect ratio exactly. The master
is not in this repository; a 948 MiB file cannot be cloned or pushed.

### Scene Two

Transcoded from `20260913_183934_840.mp4`, a 2560 × 1440, 24 fps recording
lasting 123.29 seconds. The distributed clip retains source 0:00–1:03, scaled
to 1920 × 1080 using H.264 CRF 28 with the slow preset. It preserves 24 fps,
removes audio, and enables MP4 fast start for playback while downloading.
Its embedded title is `Scene Two`; the master is not included.

`scene-two-clean-frame.jpg` is an unchanged copy of the supplied
`20260913_182647_309.jpg`. It retains its original 4000 × 2250 resolution and
the same 16:9 aspect ratio as the video.

### SHA-256 checksums

```
sha256  scene.mp4                  4afda94fbb0bebd9ba5a7870ea3aed21234da66eafd66f179c74e98c189593a3
sha256  clean-frame.jpg            ed9283dac416481814defb509b6a9770168b8a0a650e55a9476982dc6b281af2
sha256  scene-two.mp4              0f67116d9031ebaa7ac21b054441fdf2c4b576544b32338020f7eb1a36be894e
sha256  scene-two-clean-frame.jpg  656d50c2196834ca7885647b5a0969c7db19ae6f7083b71e3bf49d0689da0cfe
```

## Use a scene

Start the application using the [README](../../README.md#start-locally), then
follow the [step-by-step demo walkthrough](../../docs/SETUP.md#try-the-demo).
Under **Upload a recording**, select manual table drawing, click **Choose video**,
and select the video for your chosen scene. Upload the corresponding clean
reference from the table above and choose a schematic floor plan. The walkthrough
and screenshots use Scene One; for Scene Two, select `scene-two.mp4` and
`scene-two-clean-frame.jpg`. Review one table first, then add the others when you
are comfortable. Nothing here is pre-approved.

You can select your own material from any local folder. `examples/mappings` is
an optional convenience folder for your own plans that starts empty in version
control.

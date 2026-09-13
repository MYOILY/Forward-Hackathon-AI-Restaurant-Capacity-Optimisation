# Test fixture provenance

These files support automated checks and are not application examples or saved
restaurant data. They are excluded from the production image.

- `workflow/` contains a synthetic seven-table diagram recording and its image
  assets. Browser tests use it for upload, layout, playback and evidence-integrity
  scenarios; controlled test observations are not restaurant measurements.
- `perspective/` contains synthetic corner-marker pixels for independent image
  rectification checks. Its manifest records the expected geometry and hashes.
- `surface/` contains two cropped frames from AI-generated footage, with source,
  hashes and independent review limitations in its manifest. These exercise
  actual CPU object/reference inference without claiming real-restaurant quality.
- `bus.jpg` and `dog.jpg` are public detector smoke-test photographs. Their source
  URLs and original file hashes are preserved in `provenance.json`.
- `live_worker_fakes.py` supplies deterministic subprocess behaviors for worker
  failure, delay and cancellation tests.

Tests author expected events and comparison outcomes independently of production
replay. The application never reads these directories at startup. User-provided
videos and floor-plan images belong in the separate empty `examples` folders.

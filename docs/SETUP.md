# Set up a restaurant

Start the application using the [README](../README.md) or
[deployment instructions](DEPLOYMENT.md). The opening screen lets you choose a
recording, connect a browser camera, or reopen a saved source. A missing service
is shown as an error; it does not open sample footage.

## Prepare your files

To try the flow immediately, use the [demo clip](../examples/demo/) and its
clean reference; skip to the next section. Otherwise place your own recordings
in [examples/videos](../examples/videos/) and floor plans in
[examples/mappings](../examples/mappings/), if helpful. Use the setup
screen to select them. Files in those folders are not automatically loaded.
A floor-plan image describes table positions; it is not a clean-table reference.

Use a fixed camera with visible tabletops and people zones. A clean photo should
show the same camera position and framing as the source video. Keep a second real
recording separate if you intend to evaluate performance after tuning.

## Choose a recording or camera

Upload an MP4, MOV or WebM. The service validates and normalizes the video before
calibration. Furniture detection can suggest table positions; all proposals still
require review. Select **Draw tables manually · skip table detection** before
uploading if you want an empty table list without loading detector models.

For a browser camera, permit camera access, inspect the preview and capture a
setup frame. Only video is requested. The device belongs to the computer running
the browser, not the EC2 instance. Camera use requires localhost or HTTPS.

## Choose a clean reference and floor plan

Select a reset frame from the recording, or upload a JPG/PNG reference photo.
For an uploaded reference, explicitly confirm that the camera framing matches.
The reference is not approved merely because it was uploaded.

Upload a floor-plan image, or explicitly choose a schematic. The photograph
determines visual comparison; the plan determines how tables are displayed.

## Review one table at a time

1. **Table corners:** name the table and mark its four tabletop corners in order.
   You can draw a rectangle and refine the points. Confirm the camera geometry.
2. **People zone:** adjust and confirm the region used to associate people with
   this table. Avoid aisles and overlap with adjacent tables where possible.
3. **Floor-plan position:** position the named shape on the plan. Drag, resize,
   rotate, choose rectangle or round/oval, and optionally lock its aspect ratio.
   Numeric inputs, arrow keys and Undo/Redo provide alternatives to dragging.
4. **Expected objects:** request a proposal, inspect its crop and detector boxes,
   edit exact counts, and explicitly approve the reference and inventory.

Add any tables that detection missed. Empty expected inventories also need
approval. Unsupported items such as napkins can still be represented by the
reference photo; inventing detector categories would not make them detectable.

Each confirmed step saves and advances only after the server accepts the save.
**Save draft** retains incomplete setup. Failed saves retain the editor state for
retry; a revision conflict does not overwrite newer work. Partial corner drawings
can be recovered in the same browser. Reopened draft quantities need a fresh
proposal before approval.

## Finish and start processing

**Finish reviewed setup** saves the setup. Start recorded analysis or live
monitoring separately. **Detection only** runs person monitoring and manual
controls without automatic tabletop readiness checks.

Saved sources can be reopened. Recorded playback includes the source video,
table map and reference/current evidence. Live monitoring sends sampled camera
frames to the service and shows the age of analyzed evidence. Stopping releases
the stream and its workers; it does not write a live video recording.

## Change a saved setup

Replacing a clean reference or changing camera polygons requires renewed visual
approval and new analysis. Replacing a floor plan requires another map-position
review while preserving valid visual evidence. Table names, rotation and map
positions do not change detector geometry or expected-object identity.

Map positions use the uploaded plan's image dimensions; schematic plans use
1000 × 650. Uploaded clean photos must match the camera aspect ratio within 1%.
Images are limited to 12 MiB and 16 megapixels. Floor plans fit within
1920 × 1080 without enlargement.

Older bundle formats are not supported by this submission. Reprocess their source
video through the reviewed setup flow instead of editing format identifiers.

See [Behavior](BEHAVIOR.md) for what each status means and
[Reference](REFERENCE.md) for input limits and storage configuration.

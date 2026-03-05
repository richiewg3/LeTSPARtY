# DEV-NOTES — Palette Detective

## Snapshot Structure

Each snapshot is a plain JavaScript object capturing the full working state at a point in time:

```js
{
  imageDataURL,           // data-URL of originalImage (PNG base-64)
  palettes,               // deep copy of globalDetectedPalettes (array of 4-color hex arrays)
  tileMappings,           // deep copy of globalTileMappings  ({x, y, index} per tile)
  paletteCounts,          // shallow copy of globalPaletteCounts (tile count per palette)
  errorTiles,             // deep copy of lastErrorTiles ({x, y, count} per bad tile)
  baseImageData,          // cloned ImageData from last analysis pass (nullable)
  settings: {
    chkSnap,              // Auto-Fix Colors checkbox state
    chkMergeBlack,        // Merge Near-Blacks checkbox state
    chkGrid,              // Show Error Grid checkbox state
  },
  activeHighlightIndex,   // which palette is highlighted on canvas (-1 = none)
  currentZoom,            // 1 | 2 | 4
  btnDownloadFixedVisible,// whether "Download Fixed Image" button is shown
  imageInfoText,          // text content of the image-info line
}
```

Restoring a snapshot re-creates the `Image` object from `imageDataURL`, redraws the canvas, applies the overlay, restores all UI controls, and re-renders the palette list.

## History Workflow

```
 ┌──────────────┐       push pre-state        ┌────────────┐
 │  undoStack[]  │ ◄──────────────────────────  │ applyAction│
 └──────────────┘       clear redoStack        └────────────┘
        │                                              ▲
        │ undo(): pop → restore                        │
        ▼                                              │
 ┌──────────────┐                               any destructive
 │  redoStack[]  │                               operation calls
 └──────────────┘                               applyAction()
        │
        │ redo(): pop → restore
        ▼
 ┌──────────────┐
 │  undoStack[]  │  (current state pushed before restoring)
 └──────────────┘
```

### Rules

| Rule | Detail |
|------|--------|
| Max depth | 20 snapshots per stack |
| New action | Snapshot pushed to `undoStack`; `redoStack` cleared |
| Undo | Current state pushed to `redoStack`; top of `undoStack` restored |
| Redo | Current state pushed to `undoStack`; top of `redoStack` restored |
| Rapid operations | A sequence counter (`_restoreSeq`) discards stale async image loads |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Shift + Z | Redo |
| Ctrl/Cmd + Y | Redo (alternate) |

### UI

Two buttons (Undo / Redo) sit in the top control bar. They are disabled when their respective stacks are empty. Tooltip shows current stack depth.

## Hooking New Operations into History

Any operation that modifies `originalImage`, pixel data, or palette assignments is "destructive" and must be wrapped.

### Step-by-step

1. **Identify the entry-point function** (the one called by `onclick` or similar).
2. **Add early-exit guards** before `applyAction` if the operation is a no-op (e.g. no image loaded, nothing to merge).
3. **Wrap the body** with `applyAction(name, fn)`:

```js
function myNewOperation() {
    if (!originalImage) return;          // guard

    applyAction('My Operation', () => {
        // ... modify pixels / palettes ...
        // ... if async (Image.onload), call runAnalysis() inside the callback
    });
}
```

`applyAction` will:
1. Capture a snapshot of the current state.
2. Push it onto `undoStack` (evicting the oldest if > 20).
3. Clear `redoStack`.
4. Execute the provided function.
5. Update the Undo / Redo button states.

### What does NOT need wrapping

- **Checkbox toggles** that call `reAnalyze()` — these are non-destructive view changes; the underlying image is unchanged and analysis is re-derivable.
- **Zoom changes** — purely cosmetic, no data loss.
- **Palette highlight toggle** — visual-only overlay.
- **Download / export actions** — read-only operations that produce files.

### Tips

- If your operation is asynchronous (e.g. builds a new `Image` from canvas), the snapshot is captured synchronously before any mutation begins, so async completion is safe.
- Always call `runAnalysis()` after modifying pixel data so the palette list, tile mappings, and overlay stay in sync.
- Keep destructive logic inside the callback passed to `applyAction`; do not mutate state before the wrapper call.

---

## Session Persistence

Work is persisted to IndexedDB so that refreshing or closing the browser does not lose progress.

### Persistence Model

Storage uses a single IndexedDB database (`PaletteDetectiveDB`) with one object store (`session`). A single key (`current`) holds the entire session payload:

```js
{
  currentState,    // serialized snapshot (same shape as history snapshots)
  undoStack,       // last 5 serialized snapshots
  redoStack,       // last 5 serialized snapshots
  paletteNames,    // array of user-entered palette name strings
  timestamp,       // Date.now() at save time
}
```

`ImageData.data` buffers are stored as `ArrayBuffer` copies (structured-clone-safe). All other fields are plain JSON-compatible objects. The image is stored as a data-URL string inside the snapshot's `imageDataURL` field.

IndexedDB was chosen over `localStorage` because image data and undo/redo stacks can easily exceed the ~5 MB `localStorage` limit. IndexedDB handles hundreds of megabytes without blocking the main thread.

The **Refresh Mode** preference (checkbox state) is stored separately in `localStorage` under key `pd_refreshMode` so it can be read synchronously on startup before the IndexedDB async open completes.

### Autosave Flow

```
 destructive action (applyAction / undo / redo / reAnalyze / runAnalysis)
        │
        ▼
  scheduleAutosave()          ← resets a 500 ms debounce timer
        │
        │  500 ms elapsed
        ▼
  saveSession()               ← builds session data, writes to IndexedDB
        │
        ▼
  _flashAutosaveIndicator()   ← shows "Saved" badge briefly
```

Autosave hooks:

| Location | Trigger |
|----------|---------|
| `applyAction` | After every destructive operation (load image, fix tiles, merge palettes) |
| `undo` / `redo` | After restoring a snapshot |
| `reAnalyze` | After checkbox setting changes |
| `runAnalysis` | Catches async completions (e.g. `fixBadTiles` image onload → `runAnalysis`) |
| `beforeunload` | Last-chance save if a debounced save is still pending |

The 500 ms debounce collapses rapid successive triggers into a single write.

Undo/redo stacks are trimmed to `MAX_PERSIST_HISTORY = 5` entries each when persisting (runtime stacks still allow up to 20).

### Restore Logic

On page load:

```
 _initPersistence()
        │
        ├─ Read pd_refreshMode from localStorage → set checkbox
        ├─ Open IndexedDB
        ├─ Load session from IndexedDB
        │
        ├─ No session or no image? → fresh start
        │
        ├─ Refresh Mode enabled? → auto-restore session (skip dialog)
        │
        └─ Refresh Mode disabled? → show restore dialog
                │
                ├─ "Restore"  → _restoreFromSession(session)
                └─ "Discard"  → clearSession()
```

`_restoreFromSession` deserializes undo/redo stacks, sets `_pendingPaletteNames` (applied after the next `renderResults` call), and calls the existing `restoreSnapshot` function.

### Refresh Mode

A **Refresh Mode** checkbox sits in the control bar. When enabled:

- The restore dialog is skipped entirely on page load.
- The session is automatically restored without user interaction.
- The preference is persisted to `localStorage` so it survives even if IndexedDB data is cleared.

### Failure Safety

All IndexedDB operations are wrapped in try/catch:

- If IndexedDB is unavailable (private browsing, disabled, etc.), persistence is silently disabled and the app works normally.
- If stored data is corrupt or deserialization fails, the session is cleared and the app starts fresh.
- `_deserializeImageData` returns `null` on any error rather than throwing.
- The `beforeunload` handler is fire-and-forget; if the browser kills the page before the transaction commits, the previous successful autosave (at most 500 ms old) is still available.

### Palette Names

Palette names (user-editable text inputs) are **not** part of the snapshot system. They are saved separately in the session's `paletteNames` array and restored via `_pendingPaletteNames`, which is consumed at the end of `renderResults`.

### Not Yet Implemented

- Multi-project tabs / multiple saved sessions.
- Export/import session files.

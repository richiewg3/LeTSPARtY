# DEV-NOTES — Palette Detective History & Persistence

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

Work is persisted to **IndexedDB** so that refreshing or closing the browser does not lose progress. `localStorage` is deliberately avoided because image blobs can easily exceed its ~5 MB quota.

### Persistence Model

| Item | IndexedDB key | Format |
|------|---------------|--------|
| Session metadata | `__meta__` | `{ activeProjectId, nextProjectNum, refreshMode }` |
| Each project | `project_<id>` | Full project state (see below) |

Each project record stores:

```
{
  id, name,
  imageBlob,              // Blob – the PNG/JPEG converted from the data-URL
  palettes,               // deep-cloned palette arrays
  tileMappings,           // deep-cloned tile mapping array
  paletteCounts,          // shallow copy of per-palette tile counts
  errorTiles,             // deep-cloned bad-tile list
  settings,               // { chkSnap, chkMergeBlack, chkGrid }
  activeHighlightIndex,
  currentZoom,
  btnDownloadFixedVisible,
  imageInfoText,
  undoStack,              // trimmed to last 5 entries (serialised)
  redoStack,              // trimmed to last 5 entries (serialised)
}
```

Images are stored as **Blob** objects (via `dataURLToBlob`), which IndexedDB handles natively and efficiently. On restore they are converted back to data-URLs with `blobToDataURL` so the existing `Image.src` loading path works unchanged.

Undo/redo stack entries are serialised without `baseImageData` (an `ImageData` pixel buffer that can be several MB). On restore `baseImageData` is regenerated from the image by re-drawing and calling `ctx.getImageData`. Each stack is capped at 5 entries for persistence (`PERSIST_UNDO_LIMIT`); in-memory the runtime limit remains 20.

### Autosave Flow

```
destructive operation
        │
        ▼
  applyAction()  ──►  scheduleAutoSave()
                            │
                     500 ms debounce
                            │
                            ▼
                     persistSession()
                            │
                   ┌────────┴────────┐
                   │  saveCurrentProjectState()
                   │  openDB()
                   │  clear store
                   │  write __meta__
                   │  for each project:
                   │    convert image → Blob
                   │    trim undo/redo to 5
                   │    serialize & store
                   │  await tx.oncomplete
                   │  mark all projects clean
                   │  flash "Session saved" badge
                   └─────────────────┘
```

Every `applyAction`, `switchToProject`, `newProject`, `closeProject`, and file upload triggers `scheduleAutoSave()`, which debounces at **500 ms**. A 30-second interval also catches any missed saves.

On `beforeunload`, a fire-and-forget `persistSession()` runs as a last resort.

### Restore Logic

```
initApp()
    │
    ▼
checkSavedSession()
    │
    ├── null → startFreshSession()
    │
    └── sessionData found
            │
            ├── refreshMode ON  → auto-restore
            │
            └── refreshMode OFF → show dialog
                    │
                    ├── "Restore"  → applyRestoredSession()
                    │                    ├── success → continue
                    │                    └── failure → clearSavedSession() → startFreshSession()
                    │
                    └── "Discard"  → clearSavedSession() → startFreshSession()
```

The restore dialog is a fixed-position overlay with **Restore** / **Discard** buttons. It is shown only when:
1. A saved session exists in IndexedDB, AND
2. The "Refresh Mode" checkbox was **not** enabled.

### Refresh Mode

A **Refresh Mode** checkbox in the control bar, when enabled:
- Persists its state to the `__meta__` record in IndexedDB.
- On next page load, skips the restore dialog and **automatically** restores the previous session.

### Failure Safety

All IndexedDB operations are wrapped in `try/catch`. Specific failure scenarios:

| Scenario | Behaviour |
|----------|-----------|
| `indexedDB.open` fails or is blocked | `checkSavedSession` returns `null` → fresh session |
| Corrupt/unreadable records | `applyRestoredSession` catches, returns `false` → clears DB, fresh session |
| Image blob conversion fails | That project's image is set to `null`; other data still restores |
| `persistSession` fails | Warning logged; dirty flags remain so next interval retries |

No alert dialogs are shown on failure; the app silently falls back to a new session.

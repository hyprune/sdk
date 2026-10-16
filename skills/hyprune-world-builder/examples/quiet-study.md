# Example: a quiet study with a CPU tower whose height follows CPU load

- A small room 8 × 6 × 3 m with a window wall (a low parapet and open sky), a desk, a
  bookshelf of boxes, one large screen on the back wall (workspace 21) and a reading corner
  with a second screen (workspace 22) on a stand.
- Palette: `walnut`, `linen`, `brass` (glow 1 for the lamps).
- `cpu-tower` beside the desk: `scale` behaviour with `anchor: "bottom"` from [1, 0.1, 1] to
  [1, 1, 1]. Its source is a command (CPU load) the user adds and allows in Hyprune; place the
  tower, set the behaviour, and tell the user where to add the source.
- Look from the doorway and from the reading chair; the checklist must show both screens'
  approaches clear.

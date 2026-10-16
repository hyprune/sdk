# Example: a cosy rooftop garden at sunset with three screens and a CPU tower that glows

**Plan** (shown to the user first):

- A rooftop 24 × 18 m (a concrete slab 0.4 m high on the plain), a raised wooden deck at the
  west end (0.6 m, reached by a 1.2 m wide stair), planters along the north and south edges,
  a parapet 1 m high around the roof with a gap at the east entrance.
- Sky `sunset`, floor `grass` (the plain around the building), palette: `roof-concrete`
  (#8a8580), `deck-wood` (#8b5a3c), `planter-clay` (#a0522d), `foliage` (#3f7d3a),
  `lamp-warm` (#ffb050, glow 3).
- Screens: `screen-main` on the deck facing east (workspace 21), `screen-left` and
  `screen-right` on the roof facing the middle (workspaces 22, 23), each with 3 m clear.
- Machine: `cpu-tower`, a 0.6 × 2.4 × 0.6 m box of `lamp-warm` that grows with CPU load
  (`scale` from [1, 0.1, 1] to [1, 1, 1], anchor bottom) and glows; its source is a command
  the user allows in Hyprune (`hyprune-system-gauges cpu`), or an HTTP endpoint they name.

**Build** (abridged; every place uses `ifExists: "update"`):

```
world_create {name: "Rooftop Garden", sky: "sunset", floor: "grass", spawn: {position: [8, 0, 0], facing: "sun"}}
material_set {key: "roof-concrete", colour: "#8a8580"}            # and the other four
place {key: "roof", shape: "box", size: [24, 0.4, 18], material: "roof-concrete", position: [0, 0, 0]}
place {key: "deck", shape: "box", size: [8, 0.6, 12], material: "deck-wood", on: {key: "roof", face: "top"}, ...}
place {key: "deck-stairs", shape: "stairs", size: [1.2, 0.6, 1.8], ...}
place {key: "screen-main", ref: "<a wall screen from catalog_search>", workspace: 21, yaw: 90, ...}
look {from: "overview"}; look {from: "spawn"}; look {from: "screen-main"}; checklist {}
place {key: "cpu-tower", shape: "box", size: [0.6, 2.4, 0.6], material: "lamp-warm", ...}
behaviour_set {placement: "cpu-tower", behaviour: {key: "load", property: "scale", from: [1, 0.1, 1], to: [1, 1, 1], anchor: "bottom", smoothing: 0.5}}
behaviour_set {placement: "cpu-tower", behaviour: {key: "heat", property: "glow", from: 0.5, to: 6, colour: "#ffb050"}}
checklist {}  # fix every blocking item, then hand over
```

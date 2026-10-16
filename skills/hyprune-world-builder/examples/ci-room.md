# Example: a CI room with a conveyor bar fed by a JSON API

- A hall 16 × 10 × 4 m (four walls with a 2 m opening, a floor slab), two screens on the long
  wall facing in (workspaces 21 and 22, 3 m clear in front of each), a desk island.
- `queue-bar`: a 0.4 × 2 × 0.4 m box that grows with the queue depth:
  `source_set_http {for: "queue-bar", url: "https://ci.example.org/api/queue", map: {"value": "$.depth", "display": "$.depth"}, intervalS: 15}`
  then `behaviour_set {placement: "queue-bar", behaviour: {key: "depth", property: "scale", input: {min: 0, max: 50}, from: [1, 0.05, 1], to: [1, 1, 1], anchor: "bottom"}}`
  and a `colour` behaviour from green (#40c060) to red (#e04030).
- `source_test {for: "queue-bar"}` before handing over; if it needs a token, say which secret
  name to set in Hyprune (Objects → Data sources) rather than asking for the token.

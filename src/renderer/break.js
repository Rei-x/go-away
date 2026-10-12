// Plain script: runs in a sandboxed renderer with only window.goAway exposed.
const MICRO_TIPS = [
  "Look at something at least 6 metres away until the timer ends. Let your eyes relax.",
  "Find the farthest thing you can see out of a window and rest your eyes on it.",
  "Blink slowly a few times, then gaze into the distance.",
];
const LONG_TIPS = [
  "Stand up and walk around. A couple of minutes of light walking helps your body after sitting.",
  "Get a glass of water, and look out of a window on the way.",
  "Stand up, roll your shoulders, stretch your arms overhead and your neck side to side.",
  "Step away from the desk. Climb a flight of stairs if there is one.",
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

async function main() {
  const brk = await window.goAway.currentBreak();
  if (!brk) return;
  const long = brk.kind === "long";
  document.getElementById("title").textContent = long ? "Time to move" : "Time to look away";
  document.getElementById("tip").textContent = pick(long ? LONG_TIPS : MICRO_TIPS);
  const total = brk.endsAt - brk.startedAt;
  const render = () => {
    const left = Math.max(0, brk.endsAt - Date.now());
    const s = Math.ceil(left / 1000);
    document.getElementById("time").textContent =
      s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}`;
    document.getElementById("fill").style.width = `${100 * (1 - left / total)}%`;
  };
  render();
  setInterval(render, 250);
}

main();

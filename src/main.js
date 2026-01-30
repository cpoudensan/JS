// src/main.js
import { runGame } from "./engine.js";

runGame().catch((err) => {
  console.error("Erreur:", err);
  process.exit(1);
});

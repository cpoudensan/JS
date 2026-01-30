// src/helpers.js

export const TARGET_SCORE = 200;

export const ACTIONS = {
  FREEZE: "FREEZE",
  FLIP_THREE: "FLIP_THREE",
  SECOND_CHANCE: "SECOND_CHANCE",
};

export const MODS = {
  X2: "X2",
  PLUS: "PLUS", // +2/+4/+6/+8/+10
};

export function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deck selon le PDF :
// - nombres: 12x12, 11x11, ..., 1x1, 0x1
// - modificateurs: x2 (1), +2,+4,+6,+8,+10 (1 chacun)
// - actions: Freeze x3, Flip Three x3, Second Chance x3
export function buildDeck() {
  const deck = [];

  // Nombres 1..12 : count = value
  for (let v = 1; v <= 12; v++) {
    for (let k = 0; k < v; k++) {
      deck.push({ kind: "NUMBER", value: v });
    }
  }
  // 0 : 1 exemplaire
  deck.push({ kind: "NUMBER", value: 0 });

  // Mods score
  deck.push({ kind: "MOD", modType: MODS.X2 });
  for (const bonus of [2, 4, 6, 8, 10]) {
    deck.push({ kind: "MOD", modType: MODS.PLUS, value: bonus });
  }

  // Actions
  for (let i = 0; i < 3; i++) deck.push({ kind: "ACTION", action: ACTIONS.FREEZE });
  for (let i = 0; i < 3; i++) deck.push({ kind: "ACTION", action: ACTIONS.FLIP_THREE });
  for (let i = 0; i < 3; i++) deck.push({ kind: "ACTION", action: ACTIONS.SECOND_CHANCE });

  return shuffle(deck);
}

export function cardToString(c) {
  if (c.kind === "NUMBER") return `#${c.value}`;
  if (c.kind === "MOD" && c.modType === MODS.X2) return "x2";
  if (c.kind === "MOD" && c.modType === MODS.PLUS) return `+${c.value}`;
  if (c.kind === "ACTION" && c.action === ACTIONS.FREEZE) return "FREEZE";
  if (c.kind === "ACTION" && c.action === ACTIONS.FLIP_THREE) return "FLIP_THREE";
  if (c.kind === "ACTION" && c.action === ACTIONS.SECOND_CHANCE) return "SECOND_CHANCE";
  return "UNKNOWN";
}

export function computeRoundScore(player) {
  // Somme des cartes NUMBER (0 vaut 0)
  const numbersSum = player.rowNumbers.reduce((s, v) => s + v, 0);

  // x2 ne double QUE les points des cartes nombre (pas les +2/+4/etc.)
  const x2Count = player.rowMods.filter((m) => m.modType === MODS.X2).length;
  const doubledNumbers = numbersSum * Math.pow(2, x2Count);

  // bonus +2/+4/+6/+8/+10 s’ajoutent ensuite
  const plusSum = player.rowMods
    .filter((m) => m.modType === MODS.PLUS)
    .reduce((s, m) => s + m.value, 0);

  // Bonus Flip7 (+15) si 7 cartes NUMBER différentes
  const flip7Bonus = player.rowNumbers.length >= 7 ? 15 : 0;

  return doubledNumbers + plusSum + flip7Bonus;
}

export function hasDuplicateNumber(player, n) {
  return player.rowNumbers.includes(n);
}

export function isFlip7(player) {
  return player.rowNumbers.length >= 7;
}

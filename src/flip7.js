import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

/**
 * Flip7 (mode texte) – Node.js
 * - n joueurs
 * - clavier partagé
 * - log complet dans logs/game-YYYYMMDD-HHMMSS.log
 *
 * Règles prises du PDF (deck, actions, scoring, Flip7 +15, etc.).
 */

const TARGET_SCORE = 200;

const ACTIONS = {
  FREEZE: "FREEZE",
  FLIP_THREE: "FLIP_THREE",
  SECOND_CHANCE: "SECOND_CHANCE",
};

const MODS = {
  X2: "X2",
  PLUS: "PLUS", // +2/+4/+6/+8/+10
};

function nowStamp() {
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

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function logLine(logFile, obj) {
  fs.appendFileSync(logFile, JSON.stringify(obj) + "\n", "utf8");
}

function shuffle(arr) {
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
function buildDeck() {
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

function cardToString(c) {
  if (c.kind === "NUMBER") return `#${c.value}`;
  if (c.kind === "MOD" && c.modType === MODS.X2) return "x2";
  if (c.kind === "MOD" && c.modType === MODS.PLUS) return `+${c.value}`;
  if (c.kind === "ACTION" && c.action === ACTIONS.FREEZE) return "FREEZE";
  if (c.kind === "ACTION" && c.action === ACTIONS.FLIP_THREE) return "FLIP_THREE";
  if (c.kind === "ACTION" && c.action === ACTIONS.SECOND_CHANCE) return "SECOND_CHANCE";
  return "UNKNOWN";
}

function computeRoundScore(player) {
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

function hasDuplicateNumber(player, n) {
  return player.rowNumbers.includes(n);
}

function isFlip7(player) {
  return player.rowNumbers.length >= 7;
}

async function main() {
  const rl = readline.createInterface({ input, output });

  ensureDir("logs");
  const logFile = path.join("logs", `game-${nowStamp()}.log`);

  console.log("=== FLIP7 (mode texte) ===");
  console.log("Tous les événements sont loggés dans:", logFile);

  const nStr = await rl.question("Nombre de joueurs (>=2) ? ");
  const n = Math.max(2, parseInt(nStr, 10) || 2);

  const players = [];
  for (let i = 0; i < n; i++) {
    const name = (await rl.question(`Nom joueur ${i + 1} ? `)).trim() || `J${i + 1}`;
    players.push({
      name,
      totalScore: 0,

      // état du tour
      active: true, // encore dans le tour
      stayed: false,
      busted: false, // doublon sans seconde chance
      frozen: false,
      secondChance: false,

      rowNumbers: [], // valeurs uniques
      rowMods: [], // cartes MOD
    });
  }

  let dealerIndex = 0;

  // deck + pile de défausse globale
  let deck = buildDeck();
  let discard = [];

  logLine(logFile, { type: "GAME_START", timestamp: Date.now(), players: players.map((p) => p.name) });

  function drawCard() {
    if (deck.length === 0) {
      // Re-mélange des défausses comme indiqué dans les règles quand la pioche est épuisée
      deck = shuffle(discard);
      discard = [];
    }
    return deck.pop();
  }

  function discardCard(card) {
    discard.push(card);
  }

  function resetRoundState() {
    for (const p of players) {
      p.active = true;
      p.stayed = false;
      p.busted = false;
      p.frozen = false;
      p.secondChance = false;
      p.rowNumbers = [];
      p.rowMods = [];
    }
  }

  function anyActivePlayers() {
    return players.some((p) => p.active && !p.stayed && !p.busted && !p.frozen);
  }

  function listActivePlayerNames() {
    return players
      .filter((p) => p.active && !p.stayed && !p.busted && !p.frozen)
      .map((p) => p.name);
  }

  async function chooseActivePlayer(promptText) {
    const actives = players
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => p.active && !p.stayed && !p.busted && !p.frozen);

    if (actives.length === 0) return null;
    if (actives.length === 1) return actives[0].idx;

    console.log(promptText);
    actives.forEach(({ p, idx }, k) => console.log(`  ${k + 1}) ${p.name}`));
    while (true) {
      const ans = await rl.question("Choix (num) : ");
      const k = parseInt(ans, 10);
      if (k >= 1 && k <= actives.length) return actives[k - 1].idx;
      console.log("Choix invalide.");
    }
  }

  async function applyAction(card, receiverIdx) {
    const receiver = players[receiverIdx];

    if (card.action === ACTIONS.FREEZE) {
      receiver.frozen = true;
      receiver.active = false;
      logLine(logFile, {
        type: "ACTION_FREEZE",
        timestamp: Date.now(),
        receiver: receiver.name,
      });
      console.log(`💥 ${receiver.name} est FREEZE : éliminé du tour, score du tour = 0`);
      discardCard(card);
      return { roundEnded: false };
    }

    if (card.action === ACTIONS.SECOND_CHANCE) {
      // Le joueur la garde et pioche une autre carte tout de suite.
      // Si le joueur en a déjà une, il doit la donner à un autre joueur actif, sinon défausse.
      if (!receiver.secondChance) {
        receiver.secondChance = true;
        logLine(logFile, { type: "ACTION_SECOND_CHANCE_TAKEN", timestamp: Date.now(), player: receiver.name });
        console.log(`🧡 ${receiver.name} gagne une SECOND_CHANCE (utilisable contre un doublon).`);
      } else {
        // Donner à un autre actif si possible
        const otherIdx = await chooseActivePlayer(
          `SECOND_CHANCE supplémentaire: ${receiver.name} doit la donner à un autre joueur actif`
        );
        if (otherIdx !== null && otherIdx !== receiverIdx) {
          players[otherIdx].secondChance = true;
          logLine(logFile, {
            type: "ACTION_SECOND_CHANCE_GIVEN",
            timestamp: Date.now(),
            from: receiver.name,
            to: players[otherIdx].name,
          });
          console.log(`🧡 ${receiver.name} donne SECOND_CHANCE à ${players[otherIdx].name}.`);
        } else {
          logLine(logFile, { type: "ACTION_SECOND_CHANCE_DISCARDED", timestamp: Date.now(), by: receiver.name });
          console.log(`🧡 SECOND_CHANCE défaussée (personne ne peut la recevoir).`);
        }
      }

      discardCard(card);

      // Pioche immédiate d'une autre carte (comme règle)
      return { forceDraw: true, roundEnded: false };
    }

    if (card.action === ACTIONS.FLIP_THREE) {
      // Le joueur doit accepter 3 cartes (pioche 3 fois).
      // Important: si Flip7 arrive pendant ces cartes, le tour s'arrête immédiatement.
      logLine(logFile, { type: "ACTION_FLIP_THREE", timestamp: Date.now(), receiver: receiver.name });
      console.log(`🟨 ${receiver.name} subit FLIP_THREE : il doit piocher 3 cartes.`);

      discardCard(card);

      for (let i = 0; i < 3; i++) {
        const res = await playerDraw(receiverIdx, { forcedByFlipThree: true });
        if (res.roundEnded) return { roundEnded: true };
        if (!receiver.active) break; // éliminé (freeze/bust) pendant les 3 pioches
      }
      return { roundEnded: false };
    }

    // fallback
    discardCard(card);
    return { roundEnded: false };
  }

  async function playerDraw(playerIdx, meta = {}) {
    const player = players[playerIdx];
    const card = drawCard();

    logLine(logFile, {
      type: "DRAW",
      timestamp: Date.now(),
      player: player.name,
      card: cardToString(card),
      meta,
    });

    console.log(`→ ${player.name} pioche: ${cardToString(card)}`);

    // Carte NUMBER
    if (card.kind === "NUMBER") {
      const n = card.value;

      // Doublon -> élimination sauf si SECOND_CHANCE disponible
      if (hasDuplicateNumber(player, n)) {
        if (player.secondChance) {
          // il défausse le doublon + la seconde chance
          player.secondChance = false;
          discardCard(card);
          logLine(logFile, {
            type: "SECOND_CHANCE_USED",
            timestamp: Date.now(),
            player: player.name,
            duplicate: n,
          });
          console.log(`✅ Doublon ${n} annulé grâce à SECOND_CHANCE (carte doublon défaussée).`);
          return { roundEnded: false };
        } else {
          // bust
          player.busted = true;
          player.active = false;
          discardCard(card);
          logLine(logFile, { type: "BUST_DUPLICATE", timestamp: Date.now(), player: player.name, duplicate: n });
          console.log(`💥 Doublon ${n} : ${player.name} est éliminé du tour (0 point ce tour).`);
          return { roundEnded: false };
        }
      }

      player.rowNumbers.push(n);
      discardCard(card);

      // Flip7 stoppe immédiatement le tour, bonus +15 géré au scoring
      if (isFlip7(player)) {
        logLine(logFile, { type: "FLIP7", timestamp: Date.now(), player: player.name });
        console.log(`🎉 FLIP7 ! ${player.name} a 7 cartes numérotées : le tour s'arrête immédiatement.`);
        return { roundEnded: true };
      }

      return { roundEnded: false };
    }

    // Carte MOD
    if (card.kind === "MOD") {
      player.rowMods.push(card);
      discardCard(card);
      return { roundEnded: false };
    }

    // Carte ACTION
    if (card.kind === "ACTION") {
      const actionRes = await applyAction(card, playerIdx);

      // Certains cas forcent une pioche immédiate (SECOND_CHANCE)
      if (actionRes.forceDraw && player.active) {
        return await playerDraw(playerIdx, { forcedBy: "SECOND_CHANCE" });
      }

      return { roundEnded: actionRes.roundEnded };
    }

    // fallback
    discardCard(card);
    return { roundEnded: false };
  }

  async function initialDealRound() {
    // Le donneur distribue une carte visible à chaque joueur.
    // Si c'est une action, on l'applique immédiatement puis on continue.
    for (let i = 0; i < players.length; i++) {
      const idx = (dealerIndex + i) % players.length;
      // On distribue même si le joueur sera potentiellement freeze, etc.
      const res = await playerDraw(idx, { phase: "INITIAL_DEAL" });
      if (res.roundEnded) return true; // Flip7 pendant la distribution
    }
    return false;
  }

  async function playerTurnChoices() {
    // Le donneur propose à chaque joueur, à tour de rôle : tirer ("hit") ou rester ("stay")
    // Le tour s'arrête si plus de joueurs actifs OU si Flip7.
    let roundEndedByFlip7 = false;

    while (anyActivePlayers() && !roundEndedByFlip7) {
      for (let i = 0; i < players.length; i++) {
        const idx = (dealerIndex + i) % players.length;
        const p = players[idx];

        if (!p.active || p.stayed || p.busted || p.frozen) continue;
        if (roundEndedByFlip7) break;

        console.log("\n---");
        console.log(`Tour de ${p.name}`);
        console.log(`Cartes nombres: [${p.rowNumbers.join(", ")}] | Mods: [${p.rowMods.map(cardToString).join(", ")}] | SecondChance: ${p.secondChance ? "oui" : "non"}`);
        console.log(`Score potentiel si tu restes maintenant: ${computeRoundScore(p)}`);

        // Clavier partagé : le joueur choisit
        let choice = "";
        while (!["h", "s"].includes(choice)) {
          choice = (await rl.question("Choix: (h) recevoir une nouvelle carte / (s) rester ? ")).trim().toLowerCase();
        }

        logLine(logFile, { type: "CHOICE", timestamp: Date.now(), player: p.name, choice });

        if (choice === "s") {
          p.stayed = true;
          p.active = false;
          console.log(`${p.name} reste (il sécurise son score du tour).`);
        } else {
          const res = await playerDraw(idx, { phase: "HIT" });
          if (res.roundEnded) {
            roundEndedByFlip7 = true;
            break;
          }
        }
      }
    }

    return roundEndedByFlip7;
  }

  function finalizeRoundScores(roundEndedByFlip7) {
    console.log("\n=== Fin du tour ===");
    logLine(logFile, { type: "ROUND_END", timestamp: Date.now(), dealer: players[dealerIndex].name, endedByFlip7: roundEndedByFlip7 });

    for (const p of players) {
      let gained = 0;

      // Si freeze ou bust : 0 point du tour
      if (!p.frozen && !p.busted) {
        gained = computeRoundScore(p);
        p.totalScore += gained;
      }

      // Toutes les SECOND_CHANCE sont défaussées en fin de tour (règle)
      p.secondChance = false;

      console.log(`${p.name} gagne ${gained} points (total = ${p.totalScore})`);
      logLine(logFile, { type: "ROUND_SCORE", timestamp: Date.now(), player: p.name, gained, total: p.totalScore });
    }
  }

  function isGameOver() {
    return players.some((p) => p.totalScore >= TARGET_SCORE);
  }

  function winnerNames() {
    const max = Math.max(...players.map((p) => p.totalScore));
    return players.filter((p) => p.totalScore === max).map((p) => p.name);
  }

  // Boucle de partie
  let roundCount = 0;

  while (true) {
    roundCount++;
    console.log(`\n====================`);
    console.log(`Tour ${roundCount} | Donneur: ${players[dealerIndex].name}`);
    console.log(`====================\n`);

    logLine(logFile, { type: "ROUND_START", timestamp: Date.now(), round: roundCount, dealer: players[dealerIndex].name });

    resetRoundState();

    // 1) Distribution initiale (1 carte visible chacun, actions immédiates)
    const flip7DuringDeal = await initialDealRound();
    let endedByFlip7 = flip7DuringDeal;

    // 2) Choix hit/stay tant que joueurs actifs (sauf si déjà Flip7)
    if (!endedByFlip7) {
      endedByFlip7 = await playerTurnChoices();
    }

    // 3) Scoring fin de tour
    finalizeRoundScores(endedByFlip7);

    // 4) Condition de fin : si au moins un joueur atteint 200 à la fin du tour
    if (isGameOver()) {
      const winners = winnerNames();
      console.log("\n=== FIN DE PARTIE ===");
      console.log(`Vainqueur(s): ${winners.join(", ")} (meilleur score final)`);
      logLine(logFile, { type: "GAME_END", timestamp: Date.now(), winners, finalScores: players.map(p => ({ name: p.name, score: p.totalScore })) });
      break;
    }

    // 5) Donneur passe à gauche
    dealerIndex = (dealerIndex + 1) % players.length;
  }

  await rl.close();
}

main().catch((err) => {
  console.error("Erreur:", err);
  process.exit(1);
});

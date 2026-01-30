// src/engine.js

import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

import {
  TARGET_SCORE,
  ACTIONS,
  MODS,
  nowStamp,
  shuffle,
  buildDeck,
  cardToString,
  computeRoundScore,
  hasDuplicateNumber,
  isFlip7,
} from "./helpers.js";

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function logLine(logFile, obj) {
  fs.appendFileSync(logFile, JSON.stringify(obj) + "\n", "utf8");
}

export async function runGame() {
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
      active: true,
      stayed: false,
      busted: false,
      frozen: false,
      secondChance: false,

      rowNumbers: [],
      rowMods: [],
    });
  }

  let dealerIndex = 0;

  // deck + pile de défausse globale
  let deck = buildDeck();
  let discard = [];

  logLine(logFile, { type: "GAME_START", timestamp: Date.now(), players: players.map((p) => p.name) });

  function drawCard() {
    if (deck.length === 0) {
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

  async function chooseActivePlayer(promptText) {
    const actives = players
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => p.active && !p.stayed && !p.busted && !p.frozen);

    if (actives.length === 0) return null;
    if (actives.length === 1) return actives[0].idx;

    console.log(promptText);
    actives.forEach(({ p }, k) => console.log(`  ${k + 1}) ${p.name}`));
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
      logLine(logFile, { type: "ACTION_FREEZE", timestamp: Date.now(), receiver: receiver.name });
      console.log(`💥 ${receiver.name} est FREEZE : éliminé du tour, score du tour = 0`);
      discardCard(card);
      return { roundEnded: false };
    }

    if (card.action === ACTIONS.SECOND_CHANCE) {
      if (!receiver.secondChance) {
        receiver.secondChance = true;
        logLine(logFile, { type: "ACTION_SECOND_CHANCE_TAKEN", timestamp: Date.now(), player: receiver.name });
        console.log(`🧡 ${receiver.name} gagne une SECOND_CHANCE (utilisable contre un doublon).`);
      } else {
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
      return { forceDraw: true, roundEnded: false };
    }

    if (card.action === ACTIONS.FLIP_THREE) {
      logLine(logFile, { type: "ACTION_FLIP_THREE", timestamp: Date.now(), receiver: receiver.name });
      console.log(`🟨 ${receiver.name} subit FLIP_THREE : il doit piocher 3 cartes.`);

      discardCard(card);

      for (let i = 0; i < 3; i++) {
        const res = await playerDraw(receiverIdx, { forcedByFlipThree: true });
        if (res.roundEnded) return { roundEnded: true };
        if (!receiver.active) break;
      }
      return { roundEnded: false };
    }

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

    if (card.kind === "NUMBER") {
      const n = card.value;

      if (hasDuplicateNumber(player, n)) {
        if (player.secondChance) {
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

      if (isFlip7(player)) {
        logLine(logFile, { type: "FLIP7", timestamp: Date.now(), player: player.name });
        console.log(`🎉 FLIP7 ! ${player.name} a 7 cartes numérotées : le tour s'arrête immédiatement.`);
        return { roundEnded: true };
      }

      return { roundEnded: false };
    }

    if (card.kind === "MOD") {
      player.rowMods.push(card);
      discardCard(card);
      return { roundEnded: false };
    }

    if (card.kind === "ACTION") {
      const actionRes = await applyAction(card, playerIdx);

      if (actionRes.forceDraw && player.active) {
        return await playerDraw(playerIdx, { forcedBy: "SECOND_CHANCE" });
      }

      return { roundEnded: actionRes.roundEnded };
    }

    discardCard(card);
    return { roundEnded: false };
  }

  async function initialDealRound() {
    for (let i = 0; i < players.length; i++) {
      const idx = (dealerIndex + i) % players.length;
      const res = await playerDraw(idx, { phase: "INITIAL_DEAL" });
      if (res.roundEnded) return true;
    }
    return false;
  }

  async function playerTurnChoices() {
    let roundEndedByFlip7 = false;

    while (anyActivePlayers() && !roundEndedByFlip7) {
      for (let i = 0; i < players.length; i++) {
        const idx = (dealerIndex + i) % players.length;
        const p = players[idx];

        if (!p.active || p.stayed || p.busted || p.frozen) continue;
        if (roundEndedByFlip7) break;

        console.log("\n---");
        console.log(`Tour de ${p.name}`);
        console.log(
          `Cartes nombres: [${p.rowNumbers.join(", ")}] | Mods: [${p.rowMods.map(cardToString).join(", ")}] | SecondChance: ${
            p.secondChance ? "oui" : "non"
          }`
        );
        console.log(`Score potentiel si tu restes maintenant: ${computeRoundScore(p)}`);

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
    logLine(logFile, {
      type: "ROUND_END",
      timestamp: Date.now(),
      dealer: players[dealerIndex].name,
      endedByFlip7: roundEndedByFlip7,
    });

    for (const p of players) {
      let gained = 0;

      if (!p.frozen && !p.busted) {
        gained = computeRoundScore(p);
        p.totalScore += gained;
      }

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

    logLine(logFile, {
      type: "ROUND_START",
      timestamp: Date.now(),
      round: roundCount,
      dealer: players[dealerIndex].name,
    });

    resetRoundState();

    const flip7DuringDeal = await initialDealRound();
    let endedByFlip7 = flip7DuringDeal;

    if (!endedByFlip7) {
      endedByFlip7 = await playerTurnChoices();
    }

    finalizeRoundScores(endedByFlip7);

    if (isGameOver()) {
      const winners = winnerNames();
      console.log("\n=== FIN DE PARTIE ===");
      console.log(`Vainqueur(s): ${winners.join(", ")} (meilleur score final)`);
      logLine(logFile, {
        type: "GAME_END",
        timestamp: Date.now(),
        winners,
        finalScores: players.map((p) => ({ name: p.name, score: p.totalScore })),
      });
      break;
    }

    dealerIndex = (dealerIndex + 1) % players.length;
  }

  await rl.close();
}

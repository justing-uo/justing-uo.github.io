/*
 * Negamax / alpha-beta chess engine (JS port of the Python/python-chess
 * version) built on top of the chess.js move generator.
 *
 * Exposed as `ChessEngine` with one entry point: findBestMove(fen, opts).
 * Works in a Web Worker (importScripts) or in Node (module.exports) so the
 * exact same file can be unit-tested outside the browser.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('chess.js').Chess);
  } else {
    root.ChessEngine = factory(root.Chess);
  }
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const MATE_SCORE = 100000;
  const MAX_PLY = 128;
  const EXACT = 0, LOWER = 1, UPPER = 2;

  const PIECE_VALUES = { p: 100, n: 305, b: 333, r: 563, q: 950, k: 0 };

  // Flat 64-entry tables, index 0 = a1 ... 63 = h8 (python-chess square
  // numbering). Tuned "as written" for Black's forward direction; White
  // looks up the vertically-mirrored square (mirror = sq ^ 56).
  const PST = {
    p: [
      0, 0, 0, 0, 0, 0, 0, 0,
      50, 55, 60, 65, 65, 60, 55, 50,
      25, 30, 35, 40, 40, 35, 30, 25,
      10, 15, 20, 25, 25, 20, 15, 10,
      0, 5, 10, 15, 15, 10, 5, 0,
      -5, 0, 5, 10, 10, 5, 0, -5,
      -10, -5, 0, 5, 5, 0, -5, -10,
      0, 0, 0, 0, 0, 0, 0, 0,
    ],
    n: [
      -10, -5, -2, 0, 0, -2, -5, -10,
      -5, 0, 3, 5, 5, 3, 0, -5,
      -2, 3, 8, 10, 10, 8, 3, -2,
      0, 5, 10, 15, 15, 10, 5, 0,
      0, 5, 10, 15, 15, 10, 5, 0,
      -2, 3, 8, 10, 10, 8, 3, -2,
      -5, 0, 3, 5, 5, 3, 0, -5,
      -15, -10, -7, -5, -5, -7, -10, -15,
    ],
    b: [
      -10, -5, -2, 0, 0, -2, -5, -10,
      -5, 0, 3, 5, 5, 3, 0, -5,
      -2, 3, 8, 10, 10, 8, 3, -2,
      0, 5, 10, 15, 15, 10, 5, 0,
      0, 5, 10, 15, 15, 10, 5, 0,
      -2, 3, 8, 10, 10, 8, 3, -2,
      -5, 0, 3, 5, 5, 3, 0, -5,
      -15, -10, -7, -5, -5, -7, -10, -15,
    ],
    r: [
      0, 0, 0, 0, 0, 0, 0, 0,
      20, 20, 20, 20, 20, 20, 20, 20,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 5, 10, 15, 15, 10, 5, 0,
    ],
    q: [
      -10, -5, -2, 0, 0, -2, -5, -10,
      -5, 0, 3, 5, 5, 3, 0, -5,
      -2, 3, 8, 10, 10, 8, 3, -2,
      0, 5, 10, 15, 15, 10, 5, 0,
      0, 5, 10, 15, 15, 10, 5, 0,
      -2, 3, 8, 10, 10, 8, 3, -2,
      -5, 0, 3, 5, 5, 3, 0, -5,
      -15, -10, -7, -5, -5, -7, -10, -15,
    ],
    k: [
      20, 20, 10, 0, 0, 10, 20, 20,
      20, 10, 0, -10, -10, 0, 10, 20,
      10, 0, -10, -20, -20, -10, 0, 10,
      0, -10, -20, -30, -30, -20, -10, 0,
      0, -10, -20, -30, -30, -20, -10, 0,
      10, 0, -10, -20, -20, -10, 0, 10,
      20, 10, 0, -10, -10, 0, 10, 20,
      20, 20, 10, 0, 0, 10, 20, 20,
    ],
  };

  const KING_ENDGAME_PST = [
    -20, -20, -10, 0, 0, -10, -20, -20,
    -20, -10, 0, 10, 10, 0, -10, -20,
    -10, 0, 10, 20, 20, 10, 0, -10,
    0, 10, 20, 30, 30, 20, 10, 0,
    0, 10, 20, 30, 30, 20, 10, 0,
    -10, 0, 10, 20, 20, 10, 0, -10,
    -20, -10, 0, 10, 10, 0, -10, -20,
    -20, -20, -10, 0, 0, -10, -20, -20,
  ];

  const FILES = 'abcdefgh';

  // square() : (file 0-7, rank 1-8) -> python-chess-style index 0..63 (a1=0)
  function sq(file, rank) {
    return (rank - 1) * 8 + file;
  }

  function mirrorSq(s) {
    return s ^ 56;
  }

  function pstAt(pieceType, color, squareIdx, endgame) {
    const table = (pieceType === 'k' && endgame) ? KING_ENDGAME_PST : PST[pieceType];
    return color === 'w' ? table[mirrorSq(squareIdx)] : table[squareIdx];
  }

  // ---------------------------------------------------------------------
  // Evaluation (full recompute; simple + robust rather than incremental)
  // ---------------------------------------------------------------------
  function isQueenlessEndgame(board2d) {
    for (const row of board2d) {
      for (const cell of row) {
        if (cell && cell.type === 'q') return false;
      }
    }
    return true;
  }

  function materialPstScore(board2d) {
    let score = 0;
    const endgame = isQueenlessEndgame(board2d);
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board2d[r][f];
        if (!cell) continue;
        const rank = 8 - r; // board2d row 0 is rank 8
        const squareIdx = sq(f, rank);
        const value = PIECE_VALUES[cell.type] || 0;
        const pst = pstAt(cell.type, cell.color, squareIdx, endgame);
        score += (cell.color === 'w' ? 1 : -1) * (value + pst);
      }
    }
    return score;
  }

  function doubledPawnDiff(board2d) {
    const DOUBLED_PENALTY = 25;
    let diff = 0;
    for (const color of ['w', 'b']) {
      const files = new Array(8).fill(0);
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const cell = board2d[r][f];
          if (cell && cell.type === 'p' && cell.color === color) files[f]++;
        }
      }
      let penalty = 0;
      for (const c of files) if (c > 1) penalty += DOUBLED_PENALTY * (c - 1);
      diff += color === 'w' ? -penalty : penalty;
    }
    return diff;
  }

  // White-perspective static evaluation. Terminal states are checked first.
  function evaluate(game) {
    if (game.in_checkmate()) {
      // side to move just got mated
      return game.turn() === 'w' ? -MATE_SCORE : MATE_SCORE;
    }
    if (game.in_stalemate() || game.insufficient_material() ||
        game.in_threefold_repetition() || game.in_draw()) {
      return 0;
    }
    const board2d = game.board();
    return materialPstScore(board2d) + doubledPawnDiff(board2d);
  }

  function evaluateRelative(game) {
    const e = evaluate(game);
    return game.turn() === 'w' ? e : -e;
  }

  // ---------------------------------------------------------------------
  // Move ordering: TT move > captures (MVV-LVA) > promotions > killers > history
  // ---------------------------------------------------------------------
  function moveScore(move, ttMoveSan, killer1, killer2, historyTable, stm) {
    if (ttMoveSan && move.san === ttMoveSan) return 20000000;

    if (move.captured) {
      const v = PIECE_VALUES[move.captured] || 0;
      const a = PIECE_VALUES[move.piece] || 0;
      return 1000000 + 10 * v - a;
    }
    if (move.promotion) {
      return 900000 + (PIECE_VALUES[move.promotion] || 900);
    }
    const key = move.from + move.to;
    if (key === killer1) return 800000;
    if (key === killer2) return 700000;

    return historyTable[stm + key] || 0;
  }

  function orderMoves(moves, ttMoveSan, killerMoves, ply, historyTable, stm) {
    const [k1, k2] = ply < MAX_PLY ? killerMoves[ply] : [null, null];
    return moves
      .map((m) => ({ m, s: moveScore(m, ttMoveSan, k1, k2, historyTable, stm) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.m);
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------
  function ttKey(game) {
    // FEN without the halfmove/fullmove counters -- same position, same key
    const parts = game.fen().split(' ');
    return parts.slice(0, 4).join(' ');
  }

  function makeSearcher() {
    const TT = new Map();
    const killerMoves = Array.from({ length: MAX_PLY }, () => [null, null]);
    const historyTable = Object.create(null);
    let nodes = 0;
    let deadline = Infinity;
    let aborted = false;

    function timeUp() {
      if (Date.now() > deadline) aborted = true;
      return aborted;
    }

    function quiescence(game, alpha, beta) {
      nodes++;
      const standPat = evaluateRelative(game);
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;

      const moves = game.moves({ verbose: true }).filter((m) => m.captured || m.promotion);
      moves.sort((a, b) => {
        const va = (PIECE_VALUES[a.captured] || 0) * 10 - (PIECE_VALUES[a.piece] || 0);
        const vb = (PIECE_VALUES[b.captured] || 0) * 10 - (PIECE_VALUES[b.piece] || 0);
        return vb - va;
      });

      for (const move of moves) {
        game.move(move.san);
        const score = -quiescence(game, -beta, -alpha);
        game.undo();

        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
      }
      return alpha;
    }

    function negamax(game, depth, alpha, beta, ply) {
      nodes++;
      if ((nodes & 1023) === 0 && timeUp()) return 0;

      const originalAlpha = alpha;

      if (game.in_threefold_repetition()) return 0;

      const key = ttKey(game);
      const entry = TT.get(key);
      const ttMoveSan = entry ? entry.move : null;

      if (entry && entry.depth >= depth) {
        if (entry.flag === EXACT) return entry.score;
        if (entry.flag === LOWER && entry.score > alpha) alpha = entry.score;
        else if (entry.flag === UPPER && entry.score < beta) beta = entry.score;
        if (alpha >= beta) return entry.score;
      }

      const inCheck = game.in_check();

      if (depth <= 0) {
        const moves = game.moves();
        if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;
        return quiescence(game, alpha, beta);
      }

      const moves = game.moves({ verbose: true });
      if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;

      const stm = game.turn();
      const ordered = orderMoves(moves, ttMoveSan, killerMoves, ply, historyTable, stm);

      let bestScore = -Infinity;
      let bestMoveSan = ordered[0].san;

      for (let i = 0; i < ordered.length; i++) {
        const move = ordered[i];
        game.move(move.san);
      
        let score;
      
        if (i === 0) {
          // Full-depth search for the first move.
          score = -negamax(game, depth - 1, -beta, -alpha, ply + 1);
      
        } else {
          // Late Move Reduction:
          // Search quiet late moves 2 plies shallower.
          const lmr =
            i >= 3 &&
            depth >= 3 &&
            !inCheck &&
            !move.captured &&
            !move.promotion;
      
          const searchDepth = depth - 1 - (lmr ? 2 : 0);
      
          // PVS null-window search.
          score = -negamax(
            game,
            searchDepth,
            -alpha - 1,
            -alpha,
            ply + 1
          );
      
          // Re-search at normal depth if the reduced search
          // suggests the move could improve alpha.
          if (score > alpha) {
            score = -negamax(
              game,
              depth - 1,
              -beta,
              -alpha,
              ply + 1
            );
          }
        }
      
        game.undo();

        if (aborted) return 0;

        if (score > bestScore) {
          bestScore = score;
          bestMoveSan = move.san;
        }
        if (score > alpha) alpha = score;

        if (alpha >= beta) {
          if (!move.captured && ply < MAX_PLY) {
            const k = move.from + move.to;
            if (k !== killerMoves[ply][0]) {
              killerMoves[ply][1] = killerMoves[ply][0];
              killerMoves[ply][0] = k;
            }
            historyTable[stm + k] = (historyTable[stm + k] || 0) + depth * depth;
          }
          break;
        }
      }

      if (!entry || depth >= entry.depth) {
        let flag;
        if (bestScore <= originalAlpha) flag = UPPER;
        else if (bestScore >= beta) flag = LOWER;
        else flag = EXACT;
        TT.set(key, { depth, score: bestScore, flag, move: bestMoveSan });
      }

      return bestScore;
    }

    // Iterative deepening with aspiration windows, time-boxed.
    function findBestMove(fen, { maxDepth = 6, timeLimitMs = 3000 } = {}) {
      const game = new Chess(fen);
      nodes = 0;
      aborted = false;
      deadline = Date.now() + timeLimitMs;

      let bestMoveSan = null;
      let lastScore = 0;

      for (let d = 1; d <= maxDepth; d++) {
        for (const km of killerMoves) { km[0] = null; km[1] = null; }

        let alpha, beta;
        if (d <= 2) {
          alpha = -Infinity; beta = Infinity;
        } else {
          alpha = lastScore - 50; beta = lastScore + 50;
        }

        let score;
        for (;;) {
          score = negamax(game, d, alpha, beta, 1);
          if (aborted) break;
          if (score <= alpha) { alpha = -Infinity; continue; }
          if (score >= beta) { beta = Infinity; continue; }
          break;
        }

        if (aborted) break;

        lastScore = score;
        const entry = TT.get(ttKey(game));
        if (entry && entry.move) bestMoveSan = entry.move;

        if (Date.now() > deadline) break;
      }

      return { move: bestMoveSan, score: lastScore, nodes, depthReached: null };
    }

    return { findBestMove, get nodes() { return nodes; } };
  }

  return { makeSearcher, evaluateRelative, PIECE_VALUES };
});

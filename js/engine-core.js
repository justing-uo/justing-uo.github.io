/*
 * Faithful JS port of the Python negamax/alpha-beta engine, built on the
 * chess.js move generator. This mirrors the Python script node-for-node:
 * same PST tables, same incremental material+PST scoring via push/pop
 * deltas, same transposition table shape, same move ordering, same late
 * move reductions, same PVS re-search ladder, same two-tier repetition
 * handling (2-fold cutoff inside search, 3-fold at eval time), same
 * iterative deepening with aspiration windows.
 *
 * Exposed as `ChessEngine` with `makeSearcher()` -> { findBestMove }.
 * Works in a Web Worker (importScripts) or in Node (module.exports).
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
  // Constants (identical to the Python script)
  // ---------------------------------------------------------------------
  const MATE_SCORE = 100000;
  const MAX_PLY = 128;
  const EXACT = 0, LOWER = 1, UPPER = 2;

  const LMR_FULL_DEPTH_MOVES = 3;
  const LMR_MIN_DEPTH = 3;
  const LMR_REDUCTION = 2;

  const PIECE_VALUES = { p: 100, n: 305, b: 333, r: 563, q: 950, k: 0 };

  // _lmr_reduction() -- identical logic to the Python function of the same name.
  function lmrReduction(depth, moveIndex, inCheck, isCapture, isPromotion, givesCheck) {
    if (depth < LMR_MIN_DEPTH) return 0;
    if (moveIndex < LMR_FULL_DEPTH_MOVES) return 0;
    if (inCheck || isCapture || isPromotion || givesCheck) return 0;
    return LMR_REDUCTION;
  }

  // Flat 64-entry tables, index 0 = a1 ... 63 = h8 (python-chess square
  // numbering). Tuned "as written" for Black's forward direction; White
  // looks up the vertically-mirrored square (mirror = sq ^ 56), exactly
  // like chess.square_mirror() in the Python version.
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

  // (file 0-7, rank 1-8) -> python-chess-style square index 0..63 (a1=0)
  function sq(file, rank) {
    return (rank - 1) * 8 + file;
  }

  function algToIdx(alg) {
    const file = FILES.indexOf(alg[0]);
    const rank = parseInt(alg[1], 10);
    return sq(file, rank);
  }

  function mirrorSq(s) {
    return s ^ 56;
  }

  function pstAt(pieceType, color, squareIdx, endgame) {
    const table = (pieceType === 'k' && endgame) ? KING_ENDGAME_PST : PST[pieceType];
    return color === 'w' ? table[mirrorSq(squareIdx)] : table[squareIdx];
  }

  // ---------------------------------------------------------------------
  // Full-board helpers (used only to SEED the incremental score, and for
  // the standalone evaluate()/evaluateRelative() used outside search --
  // exactly mirroring how the Python version only fully rescans at
  // reset_incremental_eval() time, never per node).
  // ---------------------------------------------------------------------
  function countQueens(board2d) {
    let n = 0;
    for (const row of board2d) for (const cell of row) if (cell && cell.type === 'q') n++;
    return n;
  }

  function isQueenlessEndgame(board2d) {
    return countQueens(board2d) === 0;
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

  function findKingSquare(board2d, color) {
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board2d[r][f];
        if (cell && cell.type === 'k' && cell.color === color) return sq(f, 8 - r);
      }
    }
    return null;
  }

  function halfmoveClock(game) {
    const parts = game.fen().split(' ');
    return parseInt(parts[4], 10) || 0;
  }

  // position key -- board + turn + castling rights + en-passant square,
  // i.e. exactly what python-chess's board._transposition_key() captures
  // (no halfmove/fullmove counters). Used both for the TT and for
  // repetition counting, same as the Python version using one key for both.
  function positionKey(game) {
    const parts = game.fen().split(' ');
    return parts.slice(0, 4).join(' ');
  }

  // evaluate(): full recompute, White's perspective, terminal states first.
  // Only used OUTSIDE the search (mirrors Python's evaluate()/evaluate_relative(),
  // which are never called from inside negamax/quiescence either).
  function evaluate(game) {
    if (game.in_checkmate()) {
      return game.turn() === 'w' ? -MATE_SCORE : MATE_SCORE;
    }
    if (game.in_stalemate() || game.insufficient_material() ||
        halfmoveClock(game) >= 100 || game.in_threefold_repetition()) {
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
  // Move ordering -- identical priority ladder to _move_score()/order_moves()
  // ---------------------------------------------------------------------
  function moveScore(move, ttMoveSan, killer1, killer2, historyTable, stm) {
    if (ttMoveSan && move.san === ttMoveSan) return 20000000;

    if (move.flags.includes('e')) {
      // en passant: victim is always a pawn, "9 * pawn value" in the Python
      return 1000000 + 9 * PIECE_VALUES.p;
    }
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
  // Castling PST delta table -- precomputed once per (endgame, color, side),
  // identical in spirit to Python's CASTLING_DELTA.
  // ---------------------------------------------------------------------
  function castleSquares(color, kingside) {
    if (color === 'w') {
      return kingside ? ['e1', 'g1', 'h1', 'f1'] : ['e1', 'c1', 'a1', 'd1'];
    }
    return kingside ? ['e8', 'g8', 'h8', 'f8'] : ['e8', 'c8', 'a8', 'd8'];
  }

  function computeCastlingDelta(color, kingside, endgame) {
    const [kingFrom, kingTo, rookFrom, rookTo] = castleSquares(color, kingside);
    const kingDelta = pstAt('k', color, algToIdx(kingTo), endgame) - pstAt('k', color, algToIdx(kingFrom), endgame);
    const rookDelta = pstAt('r', color, algToIdx(rookTo), endgame) - pstAt('r', color, algToIdx(rookFrom), endgame);
    const sign = color === 'w' ? 1 : -1;
    return sign * (kingDelta + rookDelta);
  }

  const CASTLING_DELTA = {};
  for (const endgameFlag of [false, true]) {
    CASTLING_DELTA[endgameFlag] = {};
    for (const color of ['w', 'b']) {
      CASTLING_DELTA[endgameFlag][color] = {
        true: computeCastlingDelta(color, true, endgameFlag),
        false: computeCastlingDelta(color, false, endgameFlag),
      };
    }
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------
  function makeSearcher() {
    const TT = new Map();                 // persists across the whole game, like the Python globals
    const killerMoves = Array.from({ length: MAX_PLY }, () => [null, null]);
    const historyTable = Object.create(null);
    let nodes = 0;
    let deadline = Infinity;
    let aborted = false;

    // Per-search-call state (reset in reset() at the top of every findBestMove,
    // mirroring Python's reset_incremental_eval()).
    let incScore = 0;
    let queenCount = 0;
    let incStack = [];
    let positionCounts = new Map();

    function bumpCount(key, delta) {
      const c = (positionCounts.get(key) || 0) + delta;
      if (c <= 0) positionCounts.delete(key);
      else positionCounts.set(key, c);
    }

    function reset(game) {
      const board2d = game.board();
      incScore = materialPstScore(board2d);
      queenCount = countQueens(board2d);
      incStack = [];
    }

    // --- compute_move_delta(): change in White's-perspective material+PST
    // score that `move` will cause. Must be called with `game` still in its
    // PRE-move state. Mirrors Python's _compute_move_delta() exactly,
    // including the "reprice both kings on a phase flip" correction.
    function computeMoveDelta(game, move, preBoard2d) {
      const mover = game.turn();
      const sign = mover === 'w' ? 1 : -1;
      const opponent = mover === 'w' ? 'b' : 'w';

      const isCastle = move.flags.includes('k') || move.flags.includes('q');
      if (isCastle) {
        const endgame = queenCount === 0;
        const kingside = move.flags.includes('k');
        return { delta: CASTLING_DELTA[endgame][mover][kingside], queenDelta: 0 };
      }

      const endgameBefore = queenCount === 0;
      const pieceType = move.piece;
      const fromIdx = algToIdx(move.from);
      const toIdx = algToIdx(move.to);

      let delta = 0;
      // square 1: piece leaves its origin square
      delta -= sign * (PIECE_VALUES[pieceType] + pstAt(pieceType, mover, fromIdx, endgameBefore));

      let queenRemoved = false;

      if (move.flags.includes('e')) {
        // en passant: captured pawn sits beside (not on) the destination square
        const capIdx = sq(FILES.indexOf(move.to[0]), parseInt(move.from[1], 10));
        const oppSign = -sign;
        delta -= oppSign * (PIECE_VALUES.p + pstAt('p', opponent, capIdx, endgameBefore));
      } else if (move.captured) {
        const oppSign = -sign;
        delta -= oppSign * (PIECE_VALUES[move.captured] + pstAt(move.captured, opponent, toIdx, endgameBefore));
        queenRemoved = move.captured === 'q';
      }

      const queenAdded = move.promotion === 'q';
      let endgameAfter;
      if (queenRemoved || queenAdded) {
        const queenCountAfter = queenCount - (queenRemoved ? 1 : 0) + (queenAdded ? 1 : 0);
        endgameAfter = queenCountAfter === 0;
      } else {
        endgameAfter = endgameBefore;
      }

      // square 2: piece arrives at its destination (promotion swaps the piece type here)
      const destType = move.promotion || pieceType;
      delta += sign * (PIECE_VALUES[destType] + pstAt(destType, mover, toIdx, endgameAfter));

      // Phase-flip correction: if this move captured the last queen (or
      // promoted into the first one), both kings' PST contributions need
      // re-pricing under the new table -- even for whichever king didn't
      // move. The mover's own king (if it's the piece that moved) is
      // already correct via the "arrival" step above.
      if (endgameAfter !== endgameBefore) {
        for (const color of ['w', 'b']) {
          if (pieceType === 'k' && color === mover) continue;
          const kingSq = findKingSquare(preBoard2d, color);
          if (kingSq === null) continue;
          const csign = color === 'w' ? 1 : -1;
          const oldVal = pstAt('k', color, kingSq, endgameBefore);
          const newVal = pstAt('k', color, kingSq, endgameAfter);
          delta += csign * (newVal - oldVal);
        }
      }

      const queenDelta = (queenAdded ? 1 : 0) - (queenRemoved ? 1 : 0);
      return { delta, queenDelta };
    }

    // push_move()/pop_move(): make/unmake a move while keeping incScore,
    // queenCount, and positionCounts all in sync -- the JS analogue of
    // Python's push_move()/pop_move() PLUS the bookkeeping Python gets for
    // free from board.push()/board.pop() feeding board.is_repetition().
    function pushMove(game, move) {
      const preBoard2d = game.board();
      const { delta, queenDelta } = computeMoveDelta(game, move, preBoard2d);
      game.move(move.san);
      const key = positionKey(game);
      bumpCount(key, 1);
      incStack.push({ delta, queenDelta, key });
      incScore += delta;
      queenCount += queenDelta;
    }

    function popMove(game) {
      const entry = incStack.pop();
      bumpCount(entry.key, -1);
      game.undo();
      incScore -= entry.delta;
      queenCount -= entry.queenDelta;
    }

    // evaluate_relative_fast(): reads the incrementally maintained score
    // instead of rescanning every piece. Terminal states checked first,
    // exactly like Python -- note this uses THREEFOLD repetition (the
    // default board.is_repetition() with no count arg), matching Python's
    // evaluate()/evaluate_relative_fast() precisely. This is deliberately
    // a *different* threshold than negamax's own 2-fold cutoff below.
    function evaluateRelativeFast(game) {
      if (game.in_checkmate()) return -MATE_SCORE;
      const key = positionKey(game);
      if (game.in_stalemate() || game.insufficient_material() ||
          halfmoveClock(game) >= 100 || (positionCounts.get(key) || 0) >= 3) {
        return 0;
      }
      const totalWhite = incScore + doubledPawnDiff(game.board());
      return game.turn() === 'w' ? totalWhite : -totalWhite;
    }

    // --- quiescence(): identical structure to the Python version.
    function quiescence(game, alpha, beta) {
      nodes++;
      const standPat = evaluateRelativeFast(game);
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;

      const moves = game.moves({ verbose: true }).filter((m) => m.captured || m.promotion);
      const capScore = (m) => {
        if (m.flags.includes('e')) return 1000000;
        const v = PIECE_VALUES[m.captured] || 0;
        const a2 = PIECE_VALUES[m.piece] || 0;
        return 10 * v - a2;
      };
      moves.sort((a, b) => capScore(b) - capScore(a));

      for (const move of moves) {
        pushMove(game, move);
        const score = -quiescence(game, -beta, -alpha);
        popMove(game);

        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
      }
      return alpha;
    }

    // --- negamax(): identical structure to the Python version, including
    // the 2-fold repetition short-circuit, TT probe/store, and the full
    // LMR + PVS re-search ladder.
    function negamax(game, depth, alpha, beta, ply) {
      nodes++;
      if ((nodes & 2047) === 0 && Date.now() > deadline) aborted = true;
      if (aborted) return 0;

      const originalAlpha = alpha;

      // 2-fold cutoff -- deliberately more aggressive than the 3-fold rule
      // used at eval time, matching Python's board.is_repetition(2).
      const key = positionKey(game);
      if ((positionCounts.get(key) || 0) >= 2) return 0;

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
        const anyMoves = game.moves();
        if (anyMoves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;
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
        const isCapture = !!move.captured;
        const isPromotion = !!move.promotion;

        pushMove(game, move);
        const givesCheck = game.in_check();

        let score;
        if (i === 0) {
          // PV move searched fully
          score = -negamax(game, depth - 1, -beta, -alpha, ply + 1);
        } else {
          const reduction = lmrReduction(depth, i, inCheck, isCapture, isPromotion, givesCheck);
          const searchDepth = depth - 1 - reduction;

          // Null-window search, possibly at a reduced depth
          score = -negamax(game, searchDepth, -alpha - 1, -alpha, ply + 1);

          // If a reduced search unexpectedly beats alpha, re-verify at full
          // depth (still null window) before trusting it enough to trigger
          // a PVS re-search.
          if (reduction && score > alpha) {
            score = -negamax(game, depth - 1, -alpha - 1, -alpha, ply + 1);
          }

          // Standard PVS re-search
          if (alpha < score && score < beta) {
            score = -negamax(game, depth - 1, -beta, -alpha, ply + 1);
          }
        }

        popMove(game);

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

    // Reconstruct the game + true historical position counts by replaying
    // SAN moves from the start position. This is what lets the 2-fold /
    // 3-fold repetition checks see repeats that happened earlier in the
    // *actual* game, not just within the current search tree -- matching
    // Python's single persistent `board` object across the whole game.
    function buildGameAndCounts(fen, historySAN) {
      const g = new Chess();
      const counts = new Map();
      const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);

      bump(positionKey(g));
      if (historySAN && historySAN.length) {
        for (const san of historySAN) {
          const ok = g.move(san);
          if (!ok) throw new Error('engine-core: failed to replay move "' + san + '"');
          bump(positionKey(g));
        }
      } else if (fen) {
        g.load(fen);
        counts.clear();
        bump(positionKey(g));
      }
      return { game: g, counts };
    }

    // --- get_best_move(): iterative deepening with aspiration windows,
    // identical structure to the Python version, time-boxed.
    function findBestMove({ fen, history, maxDepth = 6, timeLimitMs = 3000 } = {}) {
      console.log("finding best move")
      const { game, counts } = buildGameAndCounts(fen, history);
      positionCounts = counts;

      nodes = 0;
      aborted = false;
      deadline = Date.now() + timeLimitMs;

      reset(game); // seed incScore/queenCount once per search, not per node

      let bestMoveSan = null;
      let lastScore = 0;

      for (let d = 1; d <= maxDepth; d++) {
        // killers are only meaningful within one search -- and, matching
        // the Python script exactly, cleared before EVERY depth iteration,
        // not just once per findBestMove call.
        for (const km of killerMoves) { km[0] = null; km[1] = null; }

        let alpha, beta;
        if (d <= 2) {
          alpha = -Infinity; beta = Infinity;
        } else {
          const window = 50;
          alpha = lastScore - window; beta = lastScore + window;
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
        const entry = TT.get(positionKey(game));
        if (entry && entry.move) bestMoveSan = entry.move;

        if (Date.now() > deadline) break;
      }

      // Defensive fallback ONLY -- not part of the ported algorithm itself.
      // Faithfully replicating Python's `board.is_repetition(2)` check means
      // negamax can return 0 at the ROOT without ever generating a move
      // (if the position to move from has already occurred once before),
      // leaving best_move as None/null at every depth -- same as the
      // Python script, which would then crash on `board.push(None)`. Rather
      // than hang the page, fall back to any legal move here.
      if (bestMoveSan === null) {
        const legalMoves = game.moves();
        if (legalMoves.length > 0) bestMoveSan = legalMoves[0];
      }

      return { move: bestMoveSan, score: lastScore, nodes };
    }

    // Debug-only surface used by the test suite to verify the incremental
    // score matches a full recompute at every node of a real search. Not
    // used by the app itself.
    function __debugRunWithChecks(fenOrHistory, maxDepth, onNode, breadth) {
      breadth = breadth || 3;
      const { game, counts } = buildGameAndCounts(fenOrHistory.fen, fenOrHistory.history);
      positionCounts = counts;
      reset(game);
      function check(label) {
        const fresh = materialPstScore(game.board());
        onNode(label, incScore, fresh, game.fen());
      }
      check('root');
      function wrappedNegamax(depth) {
        if (depth <= 0) return;
        const moves = game.moves({ verbose: true });
        if (moves.length === 0) return;
        for (let i = 0; i < Math.min(moves.length, breadth); i++) {
          pushMove(game, moves[i]);
          check('depth=' + depth + ' after ' + moves[i].san);
          wrappedNegamax(depth - 1);
          popMove(game);
          check('depth=' + depth + ' after undo ' + moves[i].san);
        }
      }
      wrappedNegamax(maxDepth);
    }

    return { findBestMove, __debugRunWithChecks };
  }

  return { makeSearcher, evaluate, evaluateRelative, PIECE_VALUES };
});

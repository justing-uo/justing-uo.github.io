(function () {
  'use strict';

  const PIECE_THEME = 'pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'';

  const STRENGTH = {
    1: { maxDepth: 1, timeLimitMs: 3600000, label: 'Level 1' },
    2: { maxDepth: 2, timeLimitMs: 3600000, label: 'Level 2' },
    3: { maxDepth: 3, timeLimitMs: 3600000, label: 'Level 3' },
    4: { maxDepth: 4, timeLimitMs: 3600000, label: 'Level 4' },
    5: { maxDepth: 5, timeLimitMs: 3600000, label: 'Level 5' },
    6: { maxDepth: 6, timeLimitMs: 3600000, label: 'Level 6' },
  };

  const game = new Chess();
  let humanColor = 'w';
  let engineThinking = false;
  let requestSeq = 0;

  const worker = new Worker('js/worker.js');

  // -------------------------------------------------------------- elements
  const els = {
    consoleLight: document.getElementById('consoleLight'),
    consoleStatus: document.getElementById('consoleStatus'),
    readoutDepth: document.getElementById('readoutDepth'),
    readoutNodes: document.getElementById('readoutNodes'),
    readoutEval: document.getElementById('readoutEval'),
    readoutTime: document.getElementById('readoutTime'),
    evalBarFill: document.getElementById('evalBarFill'),
    moveList: document.getElementById('moveList'),
    newGameBtn: document.getElementById('newGameBtn'),
    undoBtn: document.getElementById('undoBtn'),
    flipBtn: document.getElementById('flipBtn'),
    sideSelect: document.getElementById('sideSelect'),
    strengthSelect: document.getElementById('strengthSelect'),
  };

  // ------------------------------------------------------------------ board
  const board = Chessboard('board', {
    position: 'start',
    draggable: true,
    pieceTheme: PIECE_THEME,
    onDragStart,
    onDrop,
    onSnapEnd,
  });

  window.addEventListener('resize', () => board.resize());

  function onDragStart(source, piece) {
    if (game.game_over()) return false;
    if (engineThinking) return false;
    if (game.turn() !== humanColor) return false;
    if (piece.search(humanColor === 'w' ? /^b/ : /^w/) !== -1) return false;
    return true;
  }

  function onDrop(source, target) {
    const move = game.move({ from: source, to: target, promotion: 'q' });
    if (move === null) return 'snapback';

    renderMoveList();
    
    if (game.game_over()) {
      announceGameOver();
      return;
    }

    requestEngineMove();
  }

  function onSnapEnd() {
    board.position(game.fen());
  }

  // ------------------------------------------------------------- engine IO
  function requestEngineMove() {
    engineThinking = true;
    requestSeq += 1;
    const myRequestId = requestSeq;
    setThinking(true);

    const strength = STRENGTH[els.strengthSelect.value];
    worker.postMessage({
      fen: game.fen(),
      maxDepth: strength.maxDepth,
      timeLimitMs: strength.timeLimitMs,
      requestId: myRequestId,
    });
  }

  worker.onmessage = function (e) {
    const { requestId, move, score, nodes, elapsedMs } = e.data;
    if (requestId !== requestSeq) return; // stale reply (e.g. after New game)

    if (move) {
      game.move(move);
      board.position(game.fen());
      renderMoveList();
    }

    els.readoutDepth.textContent = String(STRENGTH[els.strengthSelect.value].maxDepth);
    els.readoutNodes.textContent = nodes.toLocaleString();
    els.readoutTime.textContent = (elapsedMs / 1000).toFixed(2) + 's';

    // `score` is negamax-relative to whichever color just moved (the
    // engine's color). Convert to White's perspective for the eval bar.
    if (move) {
      const engineColor = game.turn() === 'w' ? 'b' : 'w';
      const whiteScore = engineColor === 'w' ? score : -score;
      paintEvalBar(whiteScore);
    }

    engineThinking = false;
    setThinking(false);

    if (game.game_over()) {
      announceGameOver();
    } else {
      els.consoleStatus.textContent = 'Your move';
    }
  };

  worker.onerror = function (err) {
    engineThinking = false;
    setThinking(false);
    els.consoleStatus.textContent = 'Engine error — see console';
    console.error('Engine worker error:', err);
  };

  // ------------------------------------------------------------------- ui
  function setThinking(isThinking) {
    els.consoleLight.classList.toggle('thinking', isThinking);
    els.consoleStatus.textContent = isThinking ? 'Thinking…' : els.consoleStatus.textContent;
    els.undoBtn.disabled = isThinking;
    els.newGameBtn.disabled = isThinking;
  }

  function paintEvalBar(whiteCentipawns) {
    const clamped = Math.max(-800, Math.min(800, whiteCentipawns));
    const pct = 50 + (clamped / 800) * 50;
    els.evalBarFill.style.width = pct + '%';
    const cp = (whiteCentipawns / 100).toFixed(2);
    els.readoutEval.textContent = (whiteCentipawns > 0 ? '+' : '') + cp;
  }

  function renderMoveList() {
    const history = game.history();
    els.moveList.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
      const moveNum = i / 2 + 1;
      const white = history[i];
      const black = history[i + 1] || '';
      const isLastWhite = i === history.length - 1;
      const isLastBlack = i + 1 === history.length - 1;

      const numEl = document.createElement('li');
      numEl.className = 'move-num';
      numEl.textContent = moveNum + '.';
      els.moveList.appendChild(numEl);

      const whiteEl = document.createElement('li');
      whiteEl.className = 'move-san' + (isLastWhite ? ' last-move' : '');
      whiteEl.textContent = white;
      els.moveList.appendChild(whiteEl);

      const blackEl = document.createElement('li');
      blackEl.className = 'move-san' + (isLastBlack ? ' last-move' : '');
      blackEl.textContent = black;
      els.moveList.appendChild(blackEl);
    }
    els.moveList.parentElement.scrollTop = els.moveList.parentElement.scrollHeight;
  }

  function announceGameOver() {
    let text;
    if (game.in_checkmate()) {
      const winner = game.turn() === 'w' ? 'Black' : 'White';
      text = winner + ' wins by checkmate';
    } else if (game.in_stalemate()) {
      text = 'Draw by stalemate';
    } else if (game.insufficient_material()) {
      text = 'Draw — insufficient material';
    } else if (game.in_threefold_repetition()) {
      text = 'Draw by repetition';
    } else if (game.in_draw()) {
      text = 'Draw by the 50-move rule';
    } else {
      text = 'Game over';
    }
    els.consoleStatus.textContent = text;
    setThinking(false);
  }

  // -------------------------------------------------------------- controls
  function newGame() {
    requestSeq += 1; // invalidate any in-flight engine reply
    engineThinking = false;
    game.reset();
    board.orientation(humanColor === 'w' ? 'white' : 'black');
    board.position('start');
    renderMoveList();
    paintEvalBar(0);
    els.readoutDepth.textContent = '—';
    els.readoutNodes.textContent = '—';
    els.readoutTime.textContent = '—';
    setThinking(false);
    els.consoleStatus.textContent = 'Your move';

    if (humanColor === 'b') {
      requestEngineMove();
    }
  }

  els.newGameBtn.addEventListener('click', newGame);

  els.undoBtn.addEventListener('click', () => {
    if (engineThinking) return;
    // Undo one full turn (engine reply + human move) so it's the human's
    // move again; if only one ply exists (engine hasn't replied yet, or
    // human is black on move 1), undo just that one.
    const history = game.history();
    if (history.length === 0) return;
    game.undo();
    if (game.history().length > 0 && game.turn() !== humanColor) {
      game.undo();
    }
    board.position(game.fen());
    renderMoveList();
    els.consoleStatus.textContent = game.turn() === humanColor ? 'Your move' : 'Thinking…';
  });

  els.flipBtn.addEventListener('click', () => board.flip());

  els.sideSelect.addEventListener('change', () => {
    humanColor = els.sideSelect.value;
    newGame();
  });

  // ------------------------------------------------------------------ init
  renderMoveList();
  paintEvalBar(0);
})();

/* Runs the search off the main thread so the board stays responsive while
 * the engine is thinking. */
importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js');
importScripts('engine-core.js');

const searcher = ChessEngine.makeSearcher();

self.onmessage = function (e) {
  const { history, maxDepth, timeLimitMs, requestId } = e.data;
  const started = Date.now();
  const result = searcher.findBestMove({ history, maxDepth, timeLimitMs });
  self.postMessage({
    requestId,
    move: result.move,
    score: result.score,
    nodes: result.nodes,
    elapsedMs: Date.now() - started,
  });
};

// P55-S2 interleave fixture: a worker that taps continuously until
// told to stop, on ITS OWN thread (token routes / budget activations /
// config snapshots all live here while the browser swaps generations).
var running = false;
function work(n) {
  var acc = 0;
  for (var i = 0; i < n; i++) { acc = (acc + i * 7) % 4096; }
  return acc;
}
self.onmessage = function (e) {
  if (e.data === 'spin' && !running) {
    running = true;
    self.postMessage({ ready: true });
    var rounds = 0;
    var timer = setInterval(function () {
      for (var k = 0; k < 40; k++) { work(200); }
      rounds++;
      if (rounds > 200) { clearInterval(timer); }
    }, 5);
  } else if (e.data === 'stop') {
    running = false;
  }
};

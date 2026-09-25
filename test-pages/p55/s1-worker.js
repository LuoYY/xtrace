// P55-S1 worker fixture: builds a same-shaped object on the WORKER
// thread so its value taps (and token registration) happen there. The
// object shape mirrors the main-thread one ({mainAcc..}/{workerAcc..}
// differ in ONE key so dumps are distinguishable).
self.onmessage = function () {
  function f(n) {
    var acc = 0;
    for (var i = 0; i < n; i++) { acc = (acc + i * 7) % 4096; }
    return acc;
  }
  var r = { workerAcc: f(20), wrap: { inner: 22 } };
  self.postMessage({ workerAcc: r.workerAcc });
};

// Sentinel matrix: user-code counters must NOT move under taps.
var counts = { getter: 0, proxy_get: 0, proxy_has: 0, iterator: 0, tostring: 0 };
function run() {
  var obj = {};
  Object.defineProperty(obj, 'g', { get: function () { counts.getter++; return 1; } });
  var target = {};
  var proxy = new Proxy(target, {
    get: function (t, k) { counts.proxy_get++; return t[k]; },
    has: function (t, k) { counts.proxy_has++; return true; },
  });
  var iterable = {};
  iterable[Symbol.iterator] = function () { counts.iterator++; var i = 0;
    return { next: function () { return i < 3 ? { value: i++, done: false } : { done: true }; } }; };
  // Special values through the accumulator under ALL-OPEN taps.
  var nan = NaN, inf = Infinity, ninf = -Infinity, zero = -0;
  var big = 123456789012345678901234567890n;             // BigInt
  var long = 'x'.repeat(200);                             // truncated string
  var arr = [1, 2, 3];                                    // ref-only
  var acc = 0;
  for (var i = 0; i < 50; i++) acc = (acc + i) % 97;
  // Touch sentinels AFTER the hot loop so taps observed the loop above.
  obj.g; proxy.anything; 'k' in proxy;
  var sum = 0; for (var v of iterable) sum += v;
  return JSON.stringify(counts) + ' acc=' + acc + ' sum=' + sum;
}
print('RESULT ' + run());

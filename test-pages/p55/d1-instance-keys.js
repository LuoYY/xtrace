// P55-E1 D1 d8 fixture: instance-key distinguishability.
// - two SAME-NAME anonymous functions (distinct instances)
// - eval of the SAME source text twice (distinct script ids)
// - a recompiled function (new bytecode instance via %ClearBytecode...)
// - a dispatcher loop (offset/opcode table with back-edges)
function namedDispatcher(n) {
  var acc = 0;
  for (var i = 0; i < n; i++) {
    acc = (acc + i * 3) % 1000;
    if (acc > 500) acc -= 7;
  }
  return acc;
}
var anon1 = function sameName(x) { return x + 1; };
var anon2 = function sameName(x) { return x + 2; };
var eval1 = eval('(function (x) { return x * 2; })');
var eval2 = eval('(function (x) { return x * 2; })');
namedDispatcher(50);
anon1(1); anon2(2); eval1(3); eval2(4);

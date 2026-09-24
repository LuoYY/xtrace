
var a = { name: 'root' };
a.self = a;                                  // cycle
a.child = { leaf: true, deep: { deeper: 1, obj: { x: 1 } } };  // 'obj' at level 3 -> depth skip
a.long = 'x'.repeat(500);                    // truncated string
a.big = 123456789012345678901234567890n;     // BigInt bounded
Object.defineProperty(a, 'acc', { get: function () { return 1; }, configurable: true });
var holey = [1, , , , 5];                     // fast holey elements
var sparse = [1]; sparse[100000] = 5; sparse[200000] = 9;  // dictionary elements
var ab = new ArrayBuffer(16);
var dv = new Uint8Array(ab); dv[0] = 0xAA;
var ta = new Uint8Array([1, 2, 3, 4]);
var detached = new ArrayBuffer(8);
%ArrayBufferDetach(detached);
var proxy = new Proxy({}, {});
var r1 = xtraceDump(a, 'root-graph', 7);
var r2 = xtraceDump(sparse, 'sparse', 7);
var r7 = xtraceDump(holey, 'holey', 7);
var big = new ArrayBuffer(20000);                 // > per-value cap -> truncated hex
var r8 = xtraceDump(big, 'bigbuf', 7);
var r3 = xtraceDump(dv, 'typed-view', 7);
var r4 = xtraceDump(detached, 'detached', 7);
var r5 = xtraceDump(proxy, 'proxy', 7);
var r6 = xtraceDump(ta, 'typed-live', 7);
print('DUMPS ' + [r1, r2, r3, r4, r5, r6, r7, r8].join(','));

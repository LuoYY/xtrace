function hot(n){var acc=0;for(var i=0;i<n;i++){acc=(acc+i*7)%4096;if(acc>2048)acc-=11;}return acc;}
var t0=Date.now();hot(3000000);print("WALL "+(Date.now()-t0));

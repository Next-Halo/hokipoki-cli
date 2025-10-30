let c3 = 0;
let c5 = 0;
for (let i = 1; i <= 100; i++) {
    c3++;
    c5++;
    let output = '';
    if (c3 === 3) {
        output += 'Fizz';
        c3 = 0;
    }
    if (c5 === 5) {
        output += 'Buzz';
        c5 = 0;
    }
}

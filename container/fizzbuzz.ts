/**
 * fizzbuzz.ts
 *
 * Small, well-typed FizzBuzz utility with a tiny CLI.
 *
 * Usage (compiled to JS or run with ts-node):
 *   node fizzbuzz.js [end]
 *   node fizzbuzz.js [start end]
 *   node fizzbuzz.js --rules "3:Fizz,5:Buzz" --sep "," 10
 */

type Rule = { divisor: number; word: string };
console.log("Loaded fizzbuzz.ts");
/**
 * Generate FizzBuzz lines for numbers in [start, end] (inclusive).
 * Default rules: 3 => "Fizz", 5 => "Buzz".
 */
export function fizzbuzzRange(
    start: number,
    end: number,
    rules: Rule[] = [
        { divisor: 3, word: "Fizz" },
        { divisor: 5, word: "Buzz" },
    ]
): string[] {
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new TypeError("start and end must be finite numbers");
    const s = Math.trunc(start);
    const e = Math.trunc(end);
    if (e < s) return [];
    const out: string[] = [];
    for (let i = s; i <= e; i++) {
        out.push(formatFizz(i, rules));
    }
    return out;
}

/**
 * Lazy generator version of fizzbuzzRange.
 */
export function* fizzbuzzGenerator(start: number, end: number, rules?: Rule[]): Generator<string> {
    const results = fizzbuzzRange(start, end, rules);
    for (const r of results) yield r;
}

function formatFizz(n: number, rules: Rule[]): string {
    if (!Number.isInteger(n)) return String(n);
    let acc = "";
    for (const r of rules) {
        if (r.divisor !== 0 && n % r.divisor === 0) acc += r.word;
    }
    return acc || String(n);
}

/* ---- Minimal CLI ---- */

function parseRules(spec?: string): Rule[] {
    if (!spec) return [
        { divisor: 3, word: "Fizz" },
        { divisor: 5, word: "Buzz" },
    ];
    // spec example: "3:Fizz,5:Buzz,7:Bang"
    return spec.split(",").map((part) => {
        const [d, ...rest] = part.split(":");
        const word = rest.join(":") || "";
        const divisor = Number(d);
        if (!Number.isInteger(divisor) || divisor === 0) throw new Error(`invalid divisor in rule "${part}"`);
        return { divisor, word: word || String(divisor) };
    });
}

function parseArgs(argv: string[]): { start: number; end: number; rules: Rule[]; sep: string } {
    let start = 1;
    let end = 100;
    let rulesSpec: string | undefined;
    let sep = "\n";

    const flags: string[] = [];
    const positionals: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--rules" || a === "-r") {
            rulesSpec = argv[i + 1];
            i++;
        } else if (a === "--sep") {
            sep = argv[i + 1] ?? sep;
            i++;
        } else if (a.startsWith("--rules=")) {
            rulesSpec = a.split("=")[1];
        } else if (a.startsWith("--sep=")) {
            sep = a.split("=")[1];
        } else if (a.startsWith("-")) {
            flags.push(a);
        } else {
            positionals.push(a);
        }
    }

    if (positionals.length === 1) {
        end = Number(positionals[0]) || end;
        start = 1;
    } else if (positionals.length >= 2) {
        start = Number(positionals[0]) || start;
        end = Number(positionals[1]) || end;
    }

    return { start, end, rules: parseRules(rulesSpec), sep };
}

if (require.main === module) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const lines = fizzbuzzRange(args.start, args.end, args.rules);
        process.stdout.write(lines.join(args.sep));
        if (!args.sep.includes("\n")) process.stdout.write("\n");
        process.exit(0);
    } catch (err: any) {
        console.error("Error:", err?.message ?? String(err));
        process.exit(2);
    }
}
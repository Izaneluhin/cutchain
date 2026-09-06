/**
 * Minimal `--key value` / `--key=value` / `--flag` argument parser.
 * No dependency so the scripts stay auditable end to end.
 */
export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      values.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(body, next);
      i++;
    } else {
      flags.add(body);
    }
  }
  return { flags, values, positional };
}

export function opt(args: ParsedArgs, key: string, fallback?: string): string | undefined {
  return args.values.get(key) ?? fallback;
}

export function req(args: ParsedArgs, key: string): string {
  const v = args.values.get(key);
  if (v === undefined || v === "") throw new Error(`--${key} is required`);
  return v;
}

export function has(args: ParsedArgs, key: string): boolean {
  return args.flags.has(key) || args.values.get(key) === "true";
}

export function usage(text: string): never {
  console.log(text.trim() + "\n");
  process.exit(0);
}

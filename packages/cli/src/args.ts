export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
}

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey) throw new Error(`Invalid option: ${token}`);
    const next = args[index + 1];
    const value =
      inlineValue ??
      (next !== undefined && !next.startsWith("--")
        ? (index += 1, next)
        : true);
    const existing = options[rawKey];
    if (existing === undefined) {
      options[rawKey] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      options[rawKey] = [String(existing), String(value)];
    }
  }
  return { positionals, options };
}

export function optionString(
  parsed: ParsedArgs,
  name: string,
  required = false
): string | undefined {
  const value = parsed.options[name];
  if (Array.isArray(value)) return value.at(-1);
  if (typeof value === "string") return value;
  if (required) throw new Error(`Missing required option --${name}`);
  return undefined;
}

export function optionBoolean(parsed: ParsedArgs, name: string): boolean {
  return parsed.options[name] === true || parsed.options[name] === "true";
}

export function optionNumber(
  parsed: ParsedArgs,
  name: string
): number | undefined {
  const raw = optionString(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

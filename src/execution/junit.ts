/** Minimal JUnit XML reader: enough to list test cases and their outcome. */
export interface JUnitCase {
  name: string;
  durationMs: number;
  outcome: "passed" | "failed" | "skipped";
  error: string | null;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : "";
};

export function parseJUnit(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[1];
    const body = m[3] ?? "";
    const failure = /<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const classname = attr(tag, "classname");
    const name = attr(tag, "name");
    cases.push({
      name: classname ? `${classname} › ${name}` : name,
      durationMs: Math.round(Number(attr(tag, "time") || 0) * 1000),
      outcome: failure ? "failed" : skipped ? "skipped" : "passed",
      error: failure
        ? decode(
            `${attr(failure[2], "message")}\n${(failure[3] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")}`.trim(),
          ).slice(0, 6000)
        : null,
    });
  }
  return cases;
}

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Helpers for the convention tests — the tests that test our tests.
 *
 * These parse the suite with the TypeScript compiler rather than regexing it.
 * A regex over `describe(` breaks on template literals, comments, and nesting,
 * which would make the convention checks either fragile or quietly toothless.
 */

export const TESTS_ROOT = path.resolve(import.meta.dirname, "..");

export function testFilePaths(): string[] {
  return readdirSync(TESTS_ROOT, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => path.join(TESTS_ROOT, entry))
    .sort();
}

export function relativeToTests(absolutePath: string): string {
  return path.relative(TESTS_ROOT, absolutePath).split(path.sep).join("/");
}

export interface BddCall {
  /** "describe" or "test" — `it` is normalised to "test". */
  kind: "describe" | "test";
  title: string;
  /** How many enclosing describe blocks this call sits inside. */
  depth: number;
  file: string;
  line: number;
}

const DESCRIBE_NAMES = new Set(["describe", "suite"]);
const TEST_NAMES = new Set(["test", "it"]);

/** Resolve `describe`, `describe.skip`, `describe.each(...)` etc. to a base name. */
function baseCalleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return baseCalleeName(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return baseCalleeName(expression.expression);
  }
  return undefined;
}

function literalTitle(node: ts.Node | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/**
 * Collect every describe/test call in the suite, with its nesting depth.
 * Titles that are not plain string literals are skipped — a dynamic title
 * cannot be checked, and the naming test asserts none exist.
 */
export function collectBddCalls(): { calls: BddCall[]; dynamicTitles: Array<{ file: string; line: number }> } {
  const calls: BddCall[] = [];
  const dynamicTitles: Array<{ file: string; line: number }> = [];

  for (const absolutePath of testFilePaths()) {
    const file = relativeToTests(absolutePath);
    const source = ts.createSourceFile(
      absolutePath,
      readFileSync(absolutePath, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );

    const visit = (node: ts.Node, depth: number): void => {
      let nextDepth = depth;

      if (ts.isCallExpression(node)) {
        const name = baseCalleeName(node.expression);
        const isDescribe = name !== undefined && DESCRIBE_NAMES.has(name);
        const isTest = name !== undefined && TEST_NAMES.has(name);

        if (isDescribe || isTest) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const title = literalTitle(node.arguments[0]);

          if (title === undefined) {
            dynamicTitles.push({ file, line });
          } else {
            calls.push({ kind: isDescribe ? "describe" : "test", title, depth, file, line });
          }

          if (isDescribe) {
            nextDepth = depth + 1;
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, nextDepth));
    };

    visit(source, 0);
  }

  return { calls, dynamicTitles };
}

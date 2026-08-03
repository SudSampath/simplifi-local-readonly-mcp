import { describe, expect, test } from "vitest";

import { collectBddCalls } from "../support/test-sources.js";

/**
 * The convention this file enforces:
 *
 *   describe("Given <precondition>", () => {
 *     test("When <action>, then <expected outcome>", () => { ... });
 *   });
 *
 * Nested describes add further Given context and start with "And ".
 *
 * Why enforce it mechanically: the point of Given/When/Then names is that a CI
 * failure reads as the violated behavior rather than as a function name. That
 * only holds if it holds everywhere — one file drifting to test("works") is
 * enough to make a failure require reading the source to interpret. A written
 * convention decays; an asserted one does not.
 */

const GIVEN = /^Given \S/;
const AND = /^And \S/;
const WHEN_THEN = /^When .+, then .+/;

describe("Given the whole test suite parsed from source", () => {
  const { calls, dynamicTitles } = collectBddCalls();

  test("When I collect describe and test calls, then the suite is not empty", () => {
    // Guards against the parser silently finding nothing, which would make
    // every other assertion in this file vacuously true.
    expect(calls.filter((call) => call.kind === "describe").length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.kind === "test").length).toBeGreaterThan(0);
  });

  test("When I read every top-level describe title, then each states a Given", () => {
    const offenders = calls
      .filter((call) => call.kind === "describe" && call.depth === 0)
      .filter((call) => !GIVEN.test(call.title))
      .map((call) => `${call.file}:${call.line} — "${call.title}"`);

    expect(offenders, "top-level describe titles must start with 'Given '").toEqual([]);
  });

  test("When I read every nested describe title, then each adds Given context with 'And '", () => {
    const offenders = calls
      .filter((call) => call.kind === "describe" && call.depth > 0)
      .filter((call) => !AND.test(call.title))
      .map((call) => `${call.file}:${call.line} — "${call.title}"`);

    expect(offenders, "nested describe titles must start with 'And '").toEqual([]);
  });

  test("When I read every test title, then each states a When and a then", () => {
    const offenders = calls
      .filter((call) => call.kind === "test")
      .filter((call) => !WHEN_THEN.test(call.title))
      .map((call) => `${call.file}:${call.line} — "${call.title}"`);

    expect(offenders, "test titles must read 'When <action>, then <outcome>'").toEqual([]);
  });

  test("When I look for tests nested directly inside no describe, then there are none", () => {
    const offenders = calls
      .filter((call) => call.kind === "test" && call.depth === 0)
      .map((call) => `${call.file}:${call.line} — "${call.title}"`);

    expect(offenders, "every test must sit inside a Given describe block").toEqual([]);
  });

  test("When I look for dynamically built titles, then there are none to escape the convention", () => {
    const offenders = dynamicTitles.map((entry) => `${entry.file}:${entry.line}`);

    expect(offenders, "describe/test titles must be plain string literals so they can be checked").toEqual([]);
  });
});

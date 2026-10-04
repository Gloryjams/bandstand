import { describe, expect, test } from "vitest";

import { buildPairLink, parsePairLink } from "../lib/pair-link";

const URL0 = "http://192.168.1.20:7800";
const KEY0 = "a".repeat(64);

describe("buildPairLink", () => {
  test("targets the app at the server origin with a hash payload", () => {
    const link = buildPairLink(URL0, KEY0);
    expect(link.startsWith(`${URL0}/app/#`)).toBe(true);
    expect(link).toContain(`key=${KEY0}`);
  });

  test("does not double up the slash when the url has a trailing one", () => {
    expect(buildPairLink("http://x:7800/", "k").startsWith("http://x:7800/app/#")).toBe(true);
  });

  test("puts the secret in the fragment, never the query", () => {
    const link = buildPairLink(URL0, KEY0);
    const u = new URL(link);
    expect(u.search).toBe(""); // nothing before the '#'
    expect(u.hash).toContain("key=");
  });
});

describe("parsePairLink", () => {
  test("round-trips a built link", () => {
    const link = buildPairLink(URL0, KEY0);
    expect(parsePairLink(new URL(link).hash)).toEqual({ url: URL0, key: KEY0 });
  });

  test("accepts a hash with or without the leading '#'", () => {
    expect(parsePairLink("url=http%3A%2F%2Fx&key=k")).toEqual({ url: "http://x", key: "k" });
    expect(parsePairLink("#url=http%3A%2F%2Fx&key=k")).toEqual({ url: "http://x", key: "k" });
  });

  test("returns null when nothing to parse or a field is missing", () => {
    expect(parsePairLink("")).toBeNull();
    expect(parsePairLink("#")).toBeNull();
    expect(parsePairLink("#url=http%3A%2F%2Fx")).toBeNull(); // no key
    expect(parsePairLink("#key=k")).toBeNull(); // no url
    expect(parsePairLink("#foo=bar")).toBeNull();
  });

  test("round-trips a key with url-unsafe characters", () => {
    const link = buildPairLink(URL0, "a+b/c=d&e");
    expect(parsePairLink(new URL(link).hash)).toEqual({ url: URL0, key: "a+b/c=d&e" });
  });
});

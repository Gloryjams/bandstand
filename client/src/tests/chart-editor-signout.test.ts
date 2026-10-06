import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { forgetLinkedChartEditor } from "../lib/chart-editor";

const configKey = "saltycharts.bandstand.v1";
afterEach(() => localStorage.removeItem(configKey));

describe("signing out of the combined app", () => {
  it("forgets the sign-in inherited by this band's editor without deleting charts", () => {
    localStorage.setItem(configKey, JSON.stringify({ url: "", key: "test-director", readerBandId: "a" }));
    localStorage.setItem("saltycharts-library-test", "kept");
    forgetLinkedChartEditor("a");
    expect(JSON.parse(localStorage.getItem(configKey)!)).toEqual({ url: "", key: "" });
    expect(localStorage.getItem("saltycharts-library-test")).toBe("kept");
    localStorage.removeItem("saltycharts-library-test");
  });
  it("preserves an explicit editor pairing and another band's pairing", () => {
    for (const config of [{ url: "", key: "test-manual" }, { url: "", key: "test-other", readerBandId: "b" }]) {
      localStorage.setItem(configKey, JSON.stringify(config));
      forgetLinkedChartEditor("a");
      expect(JSON.parse(localStorage.getItem(configKey)!)).toEqual(config);
    }
  });
});

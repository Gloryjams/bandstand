import { describe, it, expect } from "vitest";

import { asPublicChart } from "../guest/public-chart";

const DTO = {
  title: "Blue Bossa",
  artist: "Kenny Dorham",
  key: "Cm",
  time: "4/4",
  bpm: "150",
  style: "Bossa",
  capo: "",
  sections: [
    { id: "sec1", label: "Head", bars: [{ chords: "Cm7" }, { chords: "Fm7" }] },
  ],
  arrangement: [{ id: "st1", sectionId: "sec1", repeats: 2 }],
  settings: { barsPerRow: 4, fontSize: "medium", showLyrics: false, onePage: false },
};

describe("asPublicChart", () => {
  it("keeps the fields the renderer draws, ids included", () => {
    const chart = asPublicChart(DTO);
    expect(chart?.title).toBe("Blue Bossa");
    expect(chart?.key).toBe("Cm");
    expect(chart?.sections[0]?.id).toBe("sec1");
    expect(chart?.sections[0]?.bars).toHaveLength(2);
    expect(chart?.arrangement?.[0]?.sectionId).toBe("sec1");
    expect(chart?.settings.barsPerRow).toBe(4);
  });

  it("rejects a payload with nothing to draw", () => {
    expect(asPublicChart(null)).toBeNull();
    expect(asPublicChart("nope")).toBeNull();
    expect(asPublicChart([])).toBeNull();
    expect(asPublicChart({ title: "No sections" })).toBeNull();
  });

  it("coerces missing metadata strings so the renderer never dereferences undefined", () => {
    const chart = asPublicChart({ sections: [], settings: DTO.settings });
    expect(chart).not.toBeNull();
    expect(chart?.title).toBe("");
    expect(chart?.key).toBe("");
    expect(chart?.sections).toEqual([]);
  });

  it("supplies renderable settings when the payload omits them", () => {
    const chart = asPublicChart({ sections: [] });
    expect(chart?.settings).toEqual({
      barsPerRow: 4, fontSize: "medium", showLyrics: false, onePage: false,
    });
  });

  it("drops a section with no bars instead of failing the whole chart", () => {
    const chart = asPublicChart({
      ...DTO,
      sections: [...DTO.sections, { id: "bad", label: "Broken" }],
    });
    expect(chart?.sections.map((s) => s.id)).toEqual(["sec1"]);
  });

  it("ignores an arrangement that is not a list", () => {
    const chart = asPublicChart({ ...DTO, arrangement: "nope" });
    expect(chart?.arrangement).toBeUndefined();
  });
});

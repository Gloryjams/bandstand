import { describe, expect, it } from "vitest";
import { readFailureDetail, uploadFailureMessage } from "./upload-message";

describe("uploadFailureMessage", () => {
  it("shows the server's sentence for a file that is not a readable PDF", () => {
    const detail = "This file is not a PDF that Bandstand can open, so it was not added.";
    expect(uploadFailureMessage(400, detail)).toBe(detail);
  });

  it("shows the server's sentence for an empty file", () => {
    const detail = "This file is empty, so there is nothing to add.";
    expect(uploadFailureMessage(400, detail)).toBe(detail);
  });

  it("keeps the old phrase for a 400 with no detail", () => {
    expect(uploadFailureMessage(400)).toBe("unsupported file type");
    expect(uploadFailureMessage(400, "   ")).toBe("unsupported file type");
  });

  it("names a duplicate and a huge file without echoing the server", () => {
    expect(uploadFailureMessage(409, "A file with this name already exists in the library"))
      .toBe("already in the library");
    expect(uploadFailureMessage(413, "Body too large")).toBe("too large for this server");
  });

  it("falls back to the status for anything else", () => {
    expect(uploadFailureMessage(500)).toBe("failed (500)");
    expect(uploadFailureMessage(502, "Bad Gateway")).toBe("Bad Gateway");
  });
});

describe("readFailureDetail", () => {
  it("reads a string detail", async () => {
    const r = new Response(JSON.stringify({ detail: "Nope." }), { status: 400 });
    expect(await readFailureDetail(r)).toBe("Nope.");
  });

  it("ignores a body that is not the server's JSON shape", async () => {
    expect(await readFailureDetail(new Response("<html>", { status: 502 }))).toBeUndefined();
    expect(await readFailureDetail(new Response(JSON.stringify({ detail: [1] }), { status: 422 })))
      .toBeUndefined();
    expect(await readFailureDetail(new Response("", { status: 413 }))).toBeUndefined();
  });
});

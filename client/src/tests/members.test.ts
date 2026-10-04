import { describe, expect, it } from "vitest";

import {
  INVITE_FAILED, INVITE_TAKEN, buildSignInLink, cleanMemberName, inviteErrorMessage,
} from "../lib/members";
import { parsePairLink } from "../lib/pair-link";

describe("cleanMemberName", () => {
  it("trims and accepts an ordinary name", () => {
    expect(cleanMemberName("  Rea ")).toBe("Rea");
  });
  it("mirrors the server's 422 rule: empty, too long, or control characters", () => {
    expect(cleanMemberName("")).toBeNull();
    expect(cleanMemberName("   ")).toBeNull();
    expect(cleanMemberName("x".repeat(101))).toBeNull();
    expect(cleanMemberName("x".repeat(100))).toHaveLength(100);
    expect(cleanMemberName("Rea\nSmith")).toBeNull();
  });
});

describe("buildSignInLink", () => {
  it("is the same link the sign-in page already reads, key in the fragment", () => {
    const link = buildSignInLink("http://192.168.1.20:7800/", "abc123");
    expect(link.startsWith("http://192.168.1.20:7800/app/#")).toBe(true);
    expect(new URL(link).search).toBe("");
    expect(parsePairLink(new URL(link).hash)).toEqual({ url: "http://192.168.1.20:7800/", key: "abc123" });
  });
});

describe("inviteErrorMessage", () => {
  it("explains a name clash and a bad name, and stays generic otherwise", () => {
    expect(inviteErrorMessage(new Error("POST /api/member-invites -> 409"))).toBe(INVITE_TAKEN);
    expect(inviteErrorMessage(new Error("POST /api/member-invites -> 422"))).toBe("Enter a name.");
    expect(inviteErrorMessage(new Error("POST /api/member-invites -> 500"))).toBe(INVITE_FAILED);
    expect(inviteErrorMessage(new TypeError("Failed to fetch"))).toBe(INVITE_FAILED);
  });
});

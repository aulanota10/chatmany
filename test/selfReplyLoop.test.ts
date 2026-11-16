// Regression: our own public reply echoing back as a comment event must never trigger another
// public reply. Seen in production on the TEMPO post: a reply variant containing the keyword
// ("Tabela do tempo enviada na sua DM") re-triggered the campaign, producing chains of up to 7
// public replies under a single lead's comment.

import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { upsertCampaign } from "../src/db";
import { isOwnComment } from "../src/runtime";
import type { Campaign, Env } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

let runtime: unknown = null;
vi.mock("../src/runtime", async (orig) => {
  const actual = await orig<typeof import("../src/runtime")>();
  return { ...actual, buildRuntime: vi.fn(async () => runtime) };
});
const { handleWebhookEvent } = await import("../src/routes/webhook");

const SECRET = "s";
const T = Math.floor(Date.now() / 1000);
const REPLIES = ["Já mandei a tabela na sua DM 😉", "Tabela do tempo enviada na sua DM 📩"];

function campaign(): Campaign {
  return {
    campaign_id: "tempo", media_id: "m1", keywords: ["TEMPO", "TABELA"], exclude: [],
    reward: { type: "link", value: "https://x.com/t" },
    copy: { opening: "tap", opening_button: "Go", delivery: "here {reward}" },
    public_reply: { enabled: true, texts: REPLIES },
  };
}

async function sign(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const push = (id: string, text: string, fromId: string, username: string) => JSON.stringify({
  entry: [{ changes: [{ field: "comments", value: {
    id, text, timestamp: new Date(T * 1000).toISOString(),
    from: { id: fromId, username }, media: { id: "m1" } } }] }],
});

async function send(env: Env, body: string) {
  const req = new Request("https://e.test/webhook", { method: "POST", body,
    headers: { "x-hub-signature-256": await sign(body), "content-type": "application/json" } });
  return handleWebhookEvent(env, req);
}

async function setup() {
  const db = makeTestDb();
  const client = new FakeClient();
  await upsertCampaign(db, campaign(), true);
  runtime = {
    engine: new Engine(db, client as never, new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 })),
    igUserId: "OWN", auth: { username: "aulanota10" },
  };
  return { client, env: { DB: db, MODE: "webhook", APP_SECRET: SECRET, WEBHOOK_VERIFY_TOKEN: "v" } as unknown as Env };
}

describe("own public replies never re-trigger the campaign", () => {
  it("a lead's comment gets exactly one public reply even when our reply echoes back", async () => {
    const { client, env } = await setup();
    await send(env, push("c1", "Tempo", "LEAD", "anavaleria"));
    expect(client.calls.reply).toHaveLength(1);
    // Meta pushes our own reply back as a comment; it contains the keyword.
    await send(env, push("r1", "Tabela do tempo enviada na sua DM 📩", "OWN", "aulanota10"));
    await send(env, push("r2", "Já mandei a tabela na sua DM 😉", "OWN", "aulanota10"));
    expect(client.calls.reply).toHaveLength(1);
  });

  it("ignores an echo whose id differs but whose username is ours", async () => {
    const { client, env } = await setup();
    await send(env, push("r3", "Tabela do tempo enviada na sua DM 📩", "OTHER-ID-FORMAT", "AulaNota10"));
    expect(client.calls.reply).toHaveLength(0);
  });

  it("ignores an exact copy of a reply text even from an unknown account", async () => {
    const { client, env } = await setup();
    await send(env, push("r4", "Tabela do tempo enviada na sua DM 📩", "X", "x"));
    expect(client.calls.reply).toHaveLength(0);
  });

  it("isOwnComment matches by id or username", () => {
    const rt = { igUserId: "OWN", auth: { username: "aulanota10" } };
    expect(isOwnComment(rt, "OWN", undefined)).toBe(true);
    expect(isOwnComment(rt, "9", "AULANOTA10")).toBe(true);
    expect(isOwnComment(rt, "9", "lead")).toBe(false);
  });
});
